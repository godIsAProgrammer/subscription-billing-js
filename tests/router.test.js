import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";

import { BillingStore, createDefaultStore } from "../src/store.js";
import { createRouter } from "../src/router.js";

const FIXED_NOW = new Date("2026-05-09T00:00:00Z");
const fixedNowFn = () => FIXED_NOW;

function makeReq(method, url, body) {
  const req = Readable.from(body ? [JSON.stringify(body)] : []);
  req.method = method;
  req.url = url;
  return req;
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

async function request(router, method, url, body) {
  const res = makeRes();
  await router(makeReq(method, url, body), res);
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

function buildStore() {
  return new BillingStore({
    initialPlans: [
      { id: "starter", name: "Starter", price_cents: 900, interval: "month", trial_days: 14 },
      { id: "pro", name: "Pro", price_cents: 2900, interval: "month" },
      { id: "team", name: "Team", price_cents: 9900, interval: "month" },
    ],
    nowFn: fixedNowFn,
  });
}

test("health endpoint returns ok", async () => {
  const result = await request(createRouter(buildStore()), "GET", "/health");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true });
});

test("GET /plans returns default fixture sorted by id", async () => {
  const result = await request(
    createRouter(createDefaultStore({ nowFn: fixedNowFn })),
    "GET",
    "/plans",
  );
  assert.equal(result.status, 200);
  const ids = result.body.plans.map((p) => p.id);
  assert.deepEqual(ids, ["pro", "starter", "team"]);
});

test("POST /plans creates a new plan and GET /plans/:id returns it", async () => {
  const router = createRouter(buildStore());
  const created = await request(router, "POST", "/plans", {
    id: "enterprise",
    name: "Enterprise",
    price_cents: 49900,
    interval: "year",
    features: ["custom SLA"],
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.plan.id, "enterprise");
  const fetched = await request(router, "GET", "/plans/enterprise");
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.plan.interval, "year");
});

test("POST /plans rejects invalid plan with 400 + code", async () => {
  const router = createRouter(buildStore());
  const result = await request(router, "POST", "/plans", {
    id: "Bad ID",
    name: "x",
    interval: "month",
    price_cents: 100,
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, "invalid_plan_id");
});

test("GET /plans/missing returns 404 plan_not_found", async () => {
  const result = await request(createRouter(buildStore()), "GET", "/plans/missing");
  assert.equal(result.status, 404);
  assert.equal(result.body.code, "plan_not_found");
});

test("POST /subscriptions on starter creates trialing subscription", async () => {
  const router = createRouter(buildStore());
  const result = await request(router, "POST", "/subscriptions", {
    customer_id: "cus_alice",
    plan_id: "starter",
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.subscription.status, "trialing");
  assert.equal(result.body.invoice, null);
});

test("POST /subscriptions on pro creates active subscription with invoice", async () => {
  const router = createRouter(buildStore());
  const result = await request(router, "POST", "/subscriptions", {
    customer_id: "cus_bob",
    plan_id: "pro",
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.subscription.status, "active");
  assert.equal(result.body.invoice.amount_cents, 2900);
});

test("POST /subscriptions duplicate returns 409 duplicate_subscription", async () => {
  const router = createRouter(buildStore());
  await request(router, "POST", "/subscriptions", {
    customer_id: "cus_x",
    plan_id: "pro",
  });
  const dup = await request(router, "POST", "/subscriptions", {
    customer_id: "cus_x",
    plan_id: "pro",
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, "duplicate_subscription");
});

test("POST /subscriptions/:id/cancel default sets cancel_at_period_end", async () => {
  const router = createRouter(buildStore());
  const created = await request(router, "POST", "/subscriptions", {
    customer_id: "cus_c",
    plan_id: "pro",
  });
  const cancel = await request(
    router,
    "POST",
    `/subscriptions/${created.body.subscription.id}/cancel`,
    {},
  );
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.subscription.cancel_at_period_end, true);
  assert.equal(cancel.body.subscription.status, "active");
});

test("POST /subscriptions/:id/cancel with at_period_end=false hard-cancels", async () => {
  const router = createRouter(buildStore());
  const created = await request(router, "POST", "/subscriptions", {
    customer_id: "cus_d",
    plan_id: "pro",
  });
  const cancel = await request(
    router,
    "POST",
    `/subscriptions/${created.body.subscription.id}/cancel`,
    { at_period_end: false },
  );
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.subscription.status, "canceled");
});

test("POST /subscriptions/:id/change-plan upgrade returns positive prorated_amount", async () => {
  const router = createRouter(buildStore());
  const created = await request(router, "POST", "/subscriptions", {
    customer_id: "cus_e",
    plan_id: "pro",
  });
  const change = await request(
    router,
    "POST",
    `/subscriptions/${created.body.subscription.id}/change-plan`,
    { plan_id: "team" },
  );
  assert.equal(change.status, 200);
  assert.ok(change.body.prorated_amount > 0);
  assert.equal(change.body.invoice.prorated, true);
});

test("POST /invoices/preview returns prorated_amount without storing", async () => {
  const store = buildStore();
  const router = createRouter(store);
  const created = await request(router, "POST", "/subscriptions", {
    customer_id: "cus_f",
    plan_id: "pro",
  });
  const preview = await request(router, "POST", "/invoices/preview", {
    subscription_id: created.body.subscription.id,
    plan_id: "team",
  });
  assert.equal(preview.status, 200);
  assert.ok(preview.body.prorated_amount > 0);
  // 没有写库:存量发票 = 创建订阅时的 1 张
  assert.equal(store.listInvoices().length, 1);
});

test("GET /invoices?subscription_id= filters and returns newest first", async () => {
  const router = createRouter(buildStore());
  const created = await request(router, "POST", "/subscriptions", {
    customer_id: "cus_g",
    plan_id: "pro",
  });
  await request(
    router,
    "POST",
    `/subscriptions/${created.body.subscription.id}/change-plan`,
    { plan_id: "team" },
  );
  const list = await request(
    router,
    "GET",
    `/invoices?subscription_id=${created.body.subscription.id}`,
  );
  assert.equal(list.status, 200);
  assert.equal(list.body.invoices.length, 2);
  assert.ok(list.body.invoices[0].prorated);
});

test("GET /subscriptions?status=trialing filters by status", async () => {
  const router = createRouter(buildStore());
  await request(router, "POST", "/subscriptions", {
    customer_id: "cus_a",
    plan_id: "pro",
  });
  await request(router, "POST", "/subscriptions", {
    customer_id: "cus_b",
    plan_id: "starter",
  });
  const result = await request(router, "GET", "/subscriptions?status=trialing");
  assert.equal(result.status, 200);
  assert.equal(result.body.subscriptions.length, 1);
  assert.equal(result.body.subscriptions[0].plan_id, "starter");
});

test("GET /subscriptions?status=archived returns 400 invalid_status", async () => {
  const router = createRouter(buildStore());
  const result = await request(router, "GET", "/subscriptions?status=archived");
  assert.equal(result.status, 400);
  assert.equal(result.body.code, "invalid_status");
});

test("unknown path returns 404", async () => {
  const result = await request(createRouter(buildStore()), "GET", "/nope");
  assert.equal(result.status, 404);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { BillingError, MS_PER_DAY } from "../src/billing.js";
import {
  BillingStore,
  createDefaultStore,
  normalizePlan,
} from "../src/store.js";

const FIXED_NOW = new Date("2026-05-09T00:00:00Z");
const fixedNowFn = () => FIXED_NOW;

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

test("normalizePlan validates id pattern", () => {
  assert.throws(
    () =>
      normalizePlan(
        { id: "Bad ID", name: "x", interval: "month", price_cents: 100 },
        FIXED_NOW,
      ),
    BillingError,
  );
});

test("normalizePlan rejects negative or non-integer price_cents", () => {
  assert.throws(
    () =>
      normalizePlan(
        { id: "okplan", name: "x", interval: "month", price_cents: -1 },
        FIXED_NOW,
      ),
    /price_cents/,
  );
  assert.throws(
    () =>
      normalizePlan(
        { id: "okplan", name: "x", interval: "month", price_cents: 1.5 },
        FIXED_NOW,
      ),
    /price_cents/,
  );
});

test("createSubscription with trial_days creates trialing subscription, no invoice", () => {
  const store = buildStore();
  const result = store.createSubscription({
    customer_id: "cus_alice",
    plan_id: "starter",
  });
  assert.equal(result.subscription.status, "trialing");
  assert.equal(result.subscription.trial_end !== null, true);
  assert.equal(result.invoice, null);
  assert.equal(store.listInvoices().length, 0);
});

test("createSubscription without trial creates active subscription with open invoice", () => {
  const store = buildStore();
  const result = store.createSubscription({
    customer_id: "cus_bob",
    plan_id: "pro",
  });
  assert.equal(result.subscription.status, "active");
  assert.equal(result.invoice.amount_cents, 2900);
  assert.equal(result.invoice.status, "open");
  assert.equal(result.invoice.prorated, false);
  assert.equal(
    result.subscription.current_period_end,
    new Date(FIXED_NOW.getTime() + 30 * MS_PER_DAY).toISOString(),
  );
});

test("createSubscription rejects duplicate active subscription with 409", () => {
  const store = buildStore();
  store.createSubscription({ customer_id: "cus_x", plan_id: "pro" });
  assert.throws(
    () => store.createSubscription({ customer_id: "cus_x", plan_id: "pro" }),
    (e) => e instanceof BillingError && e.status === 409,
  );
});

test("createSubscription rejects unknown plan with 404", () => {
  const store = buildStore();
  assert.throws(
    () =>
      store.createSubscription({ customer_id: "cus_x", plan_id: "missing" }),
    (e) => e instanceof BillingError && e.status === 404,
  );
});

test("createSubscription rejects bad customer_id with 400", () => {
  const store = buildStore();
  assert.throws(
    () =>
      store.createSubscription({ customer_id: "bad customer!", plan_id: "pro" }),
    (e) => e instanceof BillingError && e.status === 400,
  );
});

test("cancelSubscription default sets cancel_at_period_end and keeps status", () => {
  const store = buildStore();
  const { subscription } = store.createSubscription({
    customer_id: "cus_c",
    plan_id: "pro",
  });
  const updated = store.cancelSubscription({ id: subscription.id });
  assert.equal(updated.cancel_at_period_end, true);
  assert.equal(updated.status, "active");
  assert.equal(updated.canceled_at, null);
});

test("cancelSubscription with atPeriodEnd=false sets status=canceled", () => {
  const store = buildStore();
  const { subscription } = store.createSubscription({
    customer_id: "cus_d",
    plan_id: "pro",
  });
  const updated = store.cancelSubscription({
    id: subscription.id,
    atPeriodEnd: false,
  });
  assert.equal(updated.status, "canceled");
  assert.notEqual(updated.canceled_at, null);
});

test("cancelSubscription twice returns 409", () => {
  const store = buildStore();
  const { subscription } = store.createSubscription({
    customer_id: "cus_e",
    plan_id: "pro",
  });
  store.cancelSubscription({ id: subscription.id, atPeriodEnd: false });
  assert.throws(
    () =>
      store.cancelSubscription({ id: subscription.id, atPeriodEnd: false }),
    (e) => e instanceof BillingError && e.status === 409,
  );
});

test("changeSubscriptionPlan upgrade emits prorated invoice with positive amount", () => {
  const store = buildStore();
  const { subscription } = store.createSubscription({
    customer_id: "cus_f",
    plan_id: "pro",
  });
  const result = store.changeSubscriptionPlan({
    id: subscription.id,
    newPlanId: "team",
  });
  assert.equal(result.subscription.plan_id, "team");
  assert.ok(result.prorated_amount > 0);
  assert.equal(result.invoice.prorated, true);
  assert.equal(result.invoice.amount_cents, result.prorated_amount);
});

test("changeSubscriptionPlan downgrade emits prorated invoice with negative amount", () => {
  const store = buildStore();
  const { subscription } = store.createSubscription({
    customer_id: "cus_g",
    plan_id: "team",
  });
  const result = store.changeSubscriptionPlan({
    id: subscription.id,
    newPlanId: "pro",
  });
  assert.ok(result.prorated_amount < 0);
  assert.equal(result.invoice.amount_cents, result.prorated_amount);
});

test("changeSubscriptionPlan with prorate=false skips invoice but updates plan", () => {
  const store = buildStore();
  const { subscription } = store.createSubscription({
    customer_id: "cus_h",
    plan_id: "pro",
  });
  const result = store.changeSubscriptionPlan({
    id: subscription.id,
    newPlanId: "team",
    prorate: false,
  });
  assert.equal(result.invoice, null);
  assert.equal(result.subscription.plan_id, "team");
});

test("changeSubscriptionPlan to same plan returns 409 same_plan", () => {
  const store = buildStore();
  const { subscription } = store.createSubscription({
    customer_id: "cus_i",
    plan_id: "pro",
  });
  assert.throws(
    () =>
      store.changeSubscriptionPlan({
        id: subscription.id,
        newPlanId: "pro",
      }),
    (e) => e instanceof BillingError && e.status === 409 && e.code === "same_plan",
  );
});

test("previewPlanChange returns prorated_amount without storing", () => {
  const store = buildStore();
  const { subscription } = store.createSubscription({
    customer_id: "cus_j",
    plan_id: "pro",
  });
  const before = store.listInvoices().length;
  const preview = store.previewPlanChange({
    subscription_id: subscription.id,
    plan_id: "team",
  });
  assert.ok(preview.prorated_amount > 0);
  assert.equal(preview.from_plan, "pro");
  assert.equal(preview.to_plan, "team");
  assert.equal(store.listInvoices().length, before);
});

test("listInvoices filters by subscription_id and status", () => {
  const store = buildStore();
  const { subscription } = store.createSubscription({
    customer_id: "cus_k",
    plan_id: "pro",
  });
  store.changeSubscriptionPlan({
    id: subscription.id,
    newPlanId: "team",
  });
  const filtered = store.listInvoices({ subscription_id: subscription.id });
  assert.equal(filtered.length, 2);
  const open = store.listInvoices({
    subscription_id: subscription.id,
    status: "open",
  });
  assert.equal(open.length, 2);
  assert.throws(
    () => store.listInvoices({ status: "weird" }),
    (e) => e instanceof BillingError && e.status === 400,
  );
});

test("listSubscriptions filters by customer_id and status", () => {
  const store = buildStore();
  store.createSubscription({ customer_id: "cus_a", plan_id: "pro" });
  store.createSubscription({ customer_id: "cus_b", plan_id: "starter" });
  const a = store.listSubscriptions({ customer_id: "cus_a" });
  assert.equal(a.length, 1);
  const trialing = store.listSubscriptions({ status: "trialing" });
  assert.equal(trialing.length, 1);
  assert.equal(trialing[0].customer_id, "cus_b");
});

test("createDefaultStore lists 3 plans and 1 active subscription", () => {
  const store = createDefaultStore({ nowFn: fixedNowFn });
  const ids = store.listPlans().map((p) => p.id);
  assert.deepEqual(ids, ["pro", "starter", "team"]);
  const subs = store.listSubscriptions();
  assert.equal(subs.length, 1);
  assert.equal(subs[0].customer_id, "cus_demo");
  assert.equal(subs[0].status, "active");
  assert.equal(store.listInvoices().length, 1);
});

test("upsertPlan preserves created_at across replacement", () => {
  const store = buildStore();
  const before = store.getPlan("pro").created_at;
  store.upsertPlan({
    id: "pro",
    name: "Pro v2",
    interval: "month",
    price_cents: 3900,
  });
  assert.equal(store.getPlan("pro").price_cents, 3900);
  assert.equal(store.getPlan("pro").created_at, before);
});

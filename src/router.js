import { BillingError } from "./billing.js";
import { createDefaultStore } from "./store.js";

export function createRouter(store = createDefaultStore()) {
  return async function route(req, res) {
    const url = new URL(req.url, "http://localhost");

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/plans") {
      return sendJson(res, 200, { plans: store.listPlans() });
    }

    if (req.method === "POST" && url.pathname === "/plans") {
      try {
        const plan = store.upsertPlan(await readJson(req));
        return sendJson(res, 201, { plan });
      } catch (error) {
        return errorJson(res, error);
      }
    }

    const planMatch = url.pathname.match(/^\/plans\/([^/]+)$/);
    if (req.method === "GET" && planMatch) {
      const id = decodeURIComponent(planMatch[1]);
      const plan = store.getPlan(id);
      if (!plan) {
        return sendJson(res, 404, {
          error: `plan ${id} not found`,
          code: "plan_not_found",
        });
      }
      return sendJson(res, 200, { plan });
    }

    if (req.method === "GET" && url.pathname === "/subscriptions") {
      try {
        const subscriptions = store.listSubscriptions({
          customer_id: url.searchParams.get("customer_id"),
          status: url.searchParams.get("status"),
        });
        return sendJson(res, 200, { subscriptions });
      } catch (error) {
        return errorJson(res, error);
      }
    }

    if (req.method === "POST" && url.pathname === "/subscriptions") {
      try {
        const result = store.createSubscription(await readJson(req));
        return sendJson(res, 201, result);
      } catch (error) {
        return errorJson(res, error);
      }
    }

    const subMatch = url.pathname.match(/^\/subscriptions\/([^/]+)$/);
    if (req.method === "GET" && subMatch) {
      const id = decodeURIComponent(subMatch[1]);
      const subscription = store.getSubscription(id);
      if (!subscription) {
        return sendJson(res, 404, {
          error: `subscription ${id} not found`,
          code: "subscription_not_found",
        });
      }
      return sendJson(res, 200, { subscription });
    }

    const cancelMatch = url.pathname.match(
      /^\/subscriptions\/([^/]+)\/cancel$/,
    );
    if (req.method === "POST" && cancelMatch) {
      try {
        const id = decodeURIComponent(cancelMatch[1]);
        const body = await readJson(req);
        const atPeriodEnd =
          body?.at_period_end === undefined ? true : Boolean(body.at_period_end);
        const subscription = store.cancelSubscription({ id, atPeriodEnd });
        return sendJson(res, 200, { subscription });
      } catch (error) {
        return errorJson(res, error);
      }
    }

    const changeMatch = url.pathname.match(
      /^\/subscriptions\/([^/]+)\/change-plan$/,
    );
    if (req.method === "POST" && changeMatch) {
      try {
        const id = decodeURIComponent(changeMatch[1]);
        const body = await readJson(req);
        const result = store.changeSubscriptionPlan({
          id,
          newPlanId: body?.plan_id,
          prorate: body?.prorate === undefined ? true : Boolean(body.prorate),
        });
        return sendJson(res, 200, result);
      } catch (error) {
        return errorJson(res, error);
      }
    }

    if (req.method === "POST" && url.pathname === "/invoices/preview") {
      try {
        const body = await readJson(req);
        const preview = store.previewPlanChange({
          subscription_id: body?.subscription_id,
          plan_id: body?.plan_id,
        });
        return sendJson(res, 200, preview);
      } catch (error) {
        return errorJson(res, error);
      }
    }

    if (req.method === "GET" && url.pathname === "/invoices") {
      try {
        const invoices = store.listInvoices({
          subscription_id: url.searchParams.get("subscription_id"),
          customer_id: url.searchParams.get("customer_id"),
          status: url.searchParams.get("status"),
        });
        return sendJson(res, 200, { invoices });
      } catch (error) {
        return errorJson(res, error);
      }
    }

    return sendJson(res, 404, { error: "not found" });
  };
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function errorJson(res, error) {
  if (error instanceof BillingError) {
    return sendJson(res, error.status, {
      error: error.message,
      code: error.code,
    });
  }
  return sendJson(res, 400, {
    error: error?.message ?? "bad request",
    code: "bad_request",
  });
}

export async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) {
      throw new BillingError("request body is too large", 413, "body_too_large");
    }
  }
  if (!raw.trim()) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new BillingError("invalid json", 400, "invalid_json");
  }
}

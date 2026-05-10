import { randomBytes } from "node:crypto";

import {
  BillingError,
  INTERVALS,
  MS_PER_DAY,
  addInterval,
  prorationCents,
  toDate,
  toIso,
} from "./billing.js";

export const PLAN_ID_PATTERN = /^[a-z][a-z0-9-]{2,31}$/;
export const CUSTOMER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
export const SUBSCRIPTION_STATUSES = new Set([
  "trialing",
  "active",
  "past_due",
  "canceled",
]);
export const INVOICE_STATUSES = new Set(["draft", "open", "paid", "void"]);
const ACTIVE_STATUSES = new Set(["trialing", "active", "past_due"]);

function genId(prefix) {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

export class BillingStore {
  constructor({ initialPlans = [], nowFn = () => new Date() } = {}) {
    this._plans = new Map();
    this._subscriptions = new Map();
    this._invoices = [];
    this._nowFn = nowFn;
    for (const plan of initialPlans) {
      this.upsertPlan(plan);
    }
  }

  _now() {
    return toDate(this._nowFn());
  }

  upsertPlan(input) {
    const plan = normalizePlan(input, this._now());
    const existing = this._plans.get(plan.id);
    if (existing) {
      plan.created_at = existing.created_at;
    }
    this._plans.set(plan.id, plan);
    return plan;
  }

  listPlans() {
    return Array.from(this._plans.values()).sort((a, b) =>
      a.id.localeCompare(b.id),
    );
  }

  getPlan(id) {
    return this._plans.get(String(id));
  }

  createSubscription(input) {
    const customerId = String(input?.customer_id ?? "").trim();
    if (!CUSTOMER_ID_PATTERN.test(customerId)) {
      throw new BillingError(
        "customer_id must be 1-64 chars: letters, digits, underscore or hyphen",
        400,
        "invalid_customer_id",
      );
    }
    const planId = String(input?.plan_id ?? "").trim();
    const plan = this._plans.get(planId);
    if (!plan) {
      throw new BillingError(`plan ${planId} not found`, 404, "plan_not_found");
    }

    for (const sub of this._subscriptions.values()) {
      if (
        sub.customer_id === customerId &&
        sub.plan_id === planId &&
        ACTIVE_STATUSES.has(sub.status)
      ) {
        throw new BillingError(
          `customer ${customerId} already subscribed to plan ${planId}`,
          409,
          "duplicate_subscription",
        );
      }
    }

    const now = this._now();
    const startedAt = toIso(now);
    const id = genId("sub");
    let subscription;
    let invoice = null;

    if (plan.trial_days > 0) {
      const trialEnd = new Date(now.getTime() + plan.trial_days * MS_PER_DAY);
      subscription = {
        id,
        customer_id: customerId,
        plan_id: planId,
        status: "trialing",
        started_at: startedAt,
        current_period_start: startedAt,
        current_period_end: toIso(trialEnd),
        trial_end: toIso(trialEnd),
        cancel_at_period_end: false,
        canceled_at: null,
        created_at: startedAt,
        updated_at: startedAt,
      };
    } else {
      const periodEnd = addInterval(now, plan.interval);
      subscription = {
        id,
        customer_id: customerId,
        plan_id: planId,
        status: "active",
        started_at: startedAt,
        current_period_start: startedAt,
        current_period_end: toIso(periodEnd),
        trial_end: null,
        cancel_at_period_end: false,
        canceled_at: null,
        created_at: startedAt,
        updated_at: startedAt,
      };
      invoice = this._appendInvoice({
        subscription_id: id,
        customer_id: customerId,
        plan_id: planId,
        amount_cents: plan.price_cents,
        status: "open",
        period_start: startedAt,
        period_end: toIso(periodEnd),
        issued_at: startedAt,
        prorated: false,
        description: `Initial charge for plan ${planId}`,
      });
    }

    this._subscriptions.set(id, subscription);
    return { subscription, invoice };
  }

  listSubscriptions(filter = {}) {
    const customerId = filter.customer_id ? String(filter.customer_id) : null;
    const status = filter.status ? String(filter.status) : null;
    if (status && !SUBSCRIPTION_STATUSES.has(status)) {
      throw new BillingError(
        `status must be one of trialing, active, past_due, canceled`,
        400,
        "invalid_status",
      );
    }
    return Array.from(this._subscriptions.values())
      .filter((s) => (customerId ? s.customer_id === customerId : true))
      .filter((s) => (status ? s.status === status : true))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  getSubscription(id) {
    return this._subscriptions.get(String(id));
  }

  cancelSubscription({ id, atPeriodEnd = true }) {
    const sub = this._subscriptions.get(String(id));
    if (!sub) {
      throw new BillingError(
        `subscription ${id} not found`,
        404,
        "subscription_not_found",
      );
    }
    if (sub.status === "canceled") {
      throw new BillingError(
        `subscription ${id} already canceled`,
        409,
        "already_canceled",
      );
    }
    const now = this._now();
    const updated = { ...sub, updated_at: toIso(now) };
    if (atPeriodEnd) {
      updated.cancel_at_period_end = true;
    } else {
      updated.status = "canceled";
      updated.canceled_at = toIso(now);
      updated.cancel_at_period_end = false;
    }
    this._subscriptions.set(updated.id, updated);
    return updated;
  }

  changeSubscriptionPlan({ id, newPlanId, prorate = true }) {
    const sub = this._subscriptions.get(String(id));
    if (!sub) {
      throw new BillingError(
        `subscription ${id} not found`,
        404,
        "subscription_not_found",
      );
    }
    if (sub.status === "canceled") {
      throw new BillingError(
        `subscription ${id} is canceled`,
        409,
        "subscription_canceled",
      );
    }
    const newPlan = this._plans.get(String(newPlanId));
    if (!newPlan) {
      throw new BillingError(
        `plan ${newPlanId} not found`,
        404,
        "plan_not_found",
      );
    }
    if (sub.plan_id === newPlan.id) {
      throw new BillingError(
        `subscription ${id} already on plan ${newPlan.id}`,
        409,
        "same_plan",
      );
    }
    const oldPlan = this._plans.get(sub.plan_id);
    if (!oldPlan) {
      throw new BillingError(
        `current plan ${sub.plan_id} not found`,
        500,
        "plan_not_found",
      );
    }
    const now = this._now();
    const amount = prorationCents({
      oldPriceCents: oldPlan.price_cents,
      newPriceCents: newPlan.price_cents,
      periodStart: sub.current_period_start,
      periodEnd: sub.current_period_end,
      switchDate: now,
    });
    const updated = {
      ...sub,
      plan_id: newPlan.id,
      updated_at: toIso(now),
    };
    if (sub.status === "trialing") {
      updated.current_period_end = sub.current_period_end;
    }
    this._subscriptions.set(updated.id, updated);

    let invoice = null;
    if (prorate && amount !== 0) {
      invoice = this._appendInvoice({
        subscription_id: updated.id,
        customer_id: updated.customer_id,
        plan_id: newPlan.id,
        amount_cents: amount,
        status: "open",
        period_start: toIso(now),
        period_end: sub.current_period_end,
        issued_at: toIso(now),
        prorated: true,
        description:
          amount > 0
            ? `Prorated upgrade ${oldPlan.id} → ${newPlan.id}`
            : `Prorated credit ${oldPlan.id} → ${newPlan.id}`,
      });
    }
    return { subscription: updated, invoice, prorated_amount: amount };
  }

  previewPlanChange({ subscription_id, plan_id }) {
    const sub = this._subscriptions.get(String(subscription_id));
    if (!sub) {
      throw new BillingError(
        `subscription ${subscription_id} not found`,
        404,
        "subscription_not_found",
      );
    }
    const newPlan = this._plans.get(String(plan_id));
    if (!newPlan) {
      throw new BillingError(
        `plan ${plan_id} not found`,
        404,
        "plan_not_found",
      );
    }
    if (sub.plan_id === newPlan.id) {
      return {
        subscription_id: sub.id,
        from_plan: sub.plan_id,
        to_plan: newPlan.id,
        prorated_amount: 0,
        current_period_end: sub.current_period_end,
        note: "same plan, no proration",
      };
    }
    const oldPlan = this._plans.get(sub.plan_id);
    if (!oldPlan) {
      throw new BillingError(
        `current plan ${sub.plan_id} not found`,
        500,
        "plan_not_found",
      );
    }
    const amount = prorationCents({
      oldPriceCents: oldPlan.price_cents,
      newPriceCents: newPlan.price_cents,
      periodStart: sub.current_period_start,
      periodEnd: sub.current_period_end,
      switchDate: this._now(),
    });
    return {
      subscription_id: sub.id,
      from_plan: oldPlan.id,
      to_plan: newPlan.id,
      prorated_amount: amount,
      current_period_end: sub.current_period_end,
    };
  }

  listInvoices(filter = {}) {
    const subscriptionId = filter.subscription_id
      ? String(filter.subscription_id)
      : null;
    const customerId = filter.customer_id ? String(filter.customer_id) : null;
    const status = filter.status ? String(filter.status) : null;
    if (status && !INVOICE_STATUSES.has(status)) {
      throw new BillingError(
        `status must be one of draft, open, paid, void`,
        400,
        "invalid_status",
      );
    }
    return this._invoices
      .filter((i) =>
        subscriptionId ? i.subscription_id === subscriptionId : true,
      )
      .filter((i) => (customerId ? i.customer_id === customerId : true))
      .filter((i) => (status ? i.status === status : true))
      .slice()
      .reverse();
  }

  _appendInvoice(payload) {
    const invoice = { id: genId("inv"), ...payload };
    this._invoices.push(invoice);
    return invoice;
  }
}

export function normalizePlan(input, now) {
  if (!input || typeof input !== "object") {
    throw new BillingError("plan body must be an object", 400, "invalid_body");
  }
  const id = String(input.id ?? "").trim();
  if (!PLAN_ID_PATTERN.test(id)) {
    throw new BillingError(
      "id must be 3-32 chars: lowercase letter start, then letters/digits/hyphen",
      400,
      "invalid_plan_id",
    );
  }
  const name = String(input.name ?? "").trim();
  if (!name || name.length > 200) {
    throw new BillingError("name must be 1-200 chars", 400, "invalid_name");
  }
  const interval = String(input.interval ?? "").trim();
  if (!INTERVALS.has(interval)) {
    throw new BillingError(
      `interval must be month or year`,
      400,
      "invalid_interval",
    );
  }
  const priceRaw = input.price_cents;
  if (priceRaw === undefined || priceRaw === null || priceRaw === "") {
    throw new BillingError("price_cents is required", 400, "invalid_price");
  }
  const price = Number(priceRaw);
  if (!Number.isInteger(price) || price < 0) {
    throw new BillingError(
      "price_cents must be a non-negative integer",
      400,
      "invalid_price",
    );
  }
  const trialRaw = input.trial_days ?? 0;
  const trial = Number(trialRaw);
  if (!Number.isInteger(trial) || trial < 0 || trial > 365) {
    throw new BillingError(
      "trial_days must be an integer in 0..365",
      400,
      "invalid_trial_days",
    );
  }
  let features = [];
  if (input.features !== undefined && input.features !== null) {
    if (!Array.isArray(input.features)) {
      throw new BillingError(
        "features must be an array of strings",
        400,
        "invalid_features",
      );
    }
    features = input.features.map((f) => String(f));
  }
  const nowIso = toIso(now);
  return {
    id,
    name,
    price_cents: price,
    interval,
    trial_days: trial,
    features,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

export function createDefaultStore({ nowFn = () => new Date() } = {}) {
  const store = new BillingStore({
    initialPlans: [
      {
        id: "starter",
        name: "Starter",
        price_cents: 900,
        interval: "month",
        trial_days: 14,
        features: ["1 project", "community support"],
      },
      {
        id: "pro",
        name: "Pro",
        price_cents: 2900,
        interval: "month",
        trial_days: 0,
        features: ["10 projects", "email support", "audit log"],
      },
      {
        id: "team",
        name: "Team",
        price_cents: 9900,
        interval: "month",
        trial_days: 0,
        features: ["unlimited projects", "SSO", "priority support"],
      },
    ],
    nowFn,
  });
  store.createSubscription({ customer_id: "cus_demo", plan_id: "pro" });
  return store;
}

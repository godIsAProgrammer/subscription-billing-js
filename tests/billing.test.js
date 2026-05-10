import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BillingError,
  DAYS_PER_MONTH,
  DAYS_PER_YEAR,
  MS_PER_DAY,
  addInterval,
  daysBetween,
  endTrial,
  prorationCents,
  toDate,
  toIso,
} from "../src/billing.js";

test("addInterval month adds 30 days, year adds 365 days", () => {
  const start = new Date("2026-01-01T00:00:00Z");
  assert.equal(
    addInterval(start, "month").toISOString(),
    new Date(start.getTime() + DAYS_PER_MONTH * MS_PER_DAY).toISOString(),
  );
  assert.equal(
    addInterval(start, "year").toISOString(),
    new Date(start.getTime() + DAYS_PER_YEAR * MS_PER_DAY).toISOString(),
  );
});

test("addInterval rejects invalid interval", () => {
  assert.throws(() => addInterval(new Date(), "week"), BillingError);
});

test("daysBetween returns integer day count", () => {
  const a = new Date("2026-05-01T00:00:00Z");
  const b = new Date("2026-05-11T12:00:00Z");
  assert.equal(daysBetween(a, b), 11);
});

test("prorationCents upgrade returns positive amount", () => {
  const periodStart = new Date("2026-01-01T00:00:00Z");
  const periodEnd = new Date(periodStart.getTime() + 30 * MS_PER_DAY);
  const switchDate = new Date(periodStart.getTime() + 10 * MS_PER_DAY);
  const amount = prorationCents({
    oldPriceCents: 900,
    newPriceCents: 2900,
    periodStart,
    periodEnd,
    switchDate,
  });
  assert.equal(amount, Math.round(((2900 - 900) * 20) / 30));
  assert.ok(amount > 0);
});

test("prorationCents downgrade returns negative amount", () => {
  const periodStart = new Date("2026-01-01T00:00:00Z");
  const periodEnd = new Date(periodStart.getTime() + 30 * MS_PER_DAY);
  const switchDate = new Date(periodStart.getTime() + 5 * MS_PER_DAY);
  const amount = prorationCents({
    oldPriceCents: 2900,
    newPriceCents: 900,
    periodStart,
    periodEnd,
    switchDate,
  });
  assert.ok(amount < 0);
});

test("prorationCents returns 0 when switch is past period end", () => {
  const periodStart = new Date("2026-01-01T00:00:00Z");
  const periodEnd = new Date(periodStart.getTime() + 30 * MS_PER_DAY);
  const switchDate = new Date(periodEnd.getTime() + 1 * MS_PER_DAY);
  const amount = prorationCents({
    oldPriceCents: 900,
    newPriceCents: 2900,
    periodStart,
    periodEnd,
    switchDate,
  });
  assert.equal(amount, 0);
});

test("prorationCents returns 0 when prices are equal", () => {
  const periodStart = new Date("2026-01-01T00:00:00Z");
  const periodEnd = new Date(periodStart.getTime() + 30 * MS_PER_DAY);
  const switchDate = new Date(periodStart.getTime() + 5 * MS_PER_DAY);
  const amount = prorationCents({
    oldPriceCents: 1000,
    newPriceCents: 1000,
    periodStart,
    periodEnd,
    switchDate,
  });
  assert.equal(amount, 0);
});

test("toDate / toIso roundtrip preserves UTC instant", () => {
  const iso = "2026-05-09T12:34:56.000Z";
  assert.equal(toIso(toDate(iso)), iso);
});

test("toDate rejects garbage strings", () => {
  assert.throws(() => toDate("not a date"), BillingError);
});

test("endTrial converts trialing subscription to active and emits invoice", () => {
  const now = new Date("2026-05-09T00:00:00Z");
  const subscription = {
    id: "sub_test",
    customer_id: "cus_test",
    status: "trialing",
    plan_id: "starter",
    trial_end: "2026-05-08T00:00:00Z",
    current_period_start: "2026-04-24T00:00:00Z",
    current_period_end: "2026-05-08T00:00:00Z",
  };
  const plan = { id: "starter", price_cents: 900, interval: "month" };
  const result = endTrial({ subscription, plan, now });
  assert.equal(result.subscription.status, "active");
  assert.equal(result.invoice.amount_cents, 900);
  assert.equal(result.invoice.prorated, false);
  assert.equal(result.invoice.subscription_id, "sub_test");
  assert.equal(
    result.subscription.current_period_end,
    new Date(now.getTime() + 30 * MS_PER_DAY).toISOString(),
  );
});

test("endTrial refuses to convert a non-trialing subscription", () => {
  assert.throws(
    () =>
      endTrial({
        subscription: { status: "active" },
        plan: { id: "x", interval: "month", price_cents: 1 },
        now: new Date(),
      }),
    BillingError,
  );
});

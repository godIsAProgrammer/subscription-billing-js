// 订阅计费的纯计算函数与共享常量。
// 所有时间单位以 Date / ISO 字符串呈现,内部按 UTC 整天换算,
// 不引入 luxon / date-fns,以减少容器镜像依赖。

export const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const DAYS_PER_MONTH = 30;
export const DAYS_PER_YEAR = 365;
export const INTERVALS = new Set(["month", "year"]);

export class BillingError extends Error {
  constructor(message, status = 400, code = "billing_error") {
    super(message);
    this.name = "BillingError";
    this.status = status;
    this.code = code;
  }
}

export function toDate(value) {
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (typeof value === "string" && value.length > 0) {
    const ts = Date.parse(value);
    if (Number.isNaN(ts)) {
      throw new BillingError(`invalid datetime: ${value}`, 400, "invalid_datetime");
    }
    return new Date(ts);
  }
  throw new BillingError("datetime is required", 400, "invalid_datetime");
}

export function toIso(value) {
  return toDate(value).toISOString();
}

export function addInterval(date, interval) {
  if (!INTERVALS.has(interval)) {
    throw new BillingError(`interval must be month or year, got ${interval}`, 400, "invalid_interval");
  }
  const days = interval === "year" ? DAYS_PER_YEAR : DAYS_PER_MONTH;
  return new Date(toDate(date).getTime() + days * MS_PER_DAY);
}

export function daysBetween(start, end) {
  const startMs = toDate(start).getTime();
  const endMs = toDate(end).getTime();
  return Math.round((endMs - startMs) / MS_PER_DAY);
}

// 升级/降级时按剩余天数比例计算 proration cents。
// 升级返回正数(应补差),降级返回负数(应退款)。
// totalDays 或 remainingDays 异常时统一回退到 0,避免 NaN 落库。
export function prorationCents({
  oldPriceCents,
  newPriceCents,
  periodStart,
  periodEnd,
  switchDate,
}) {
  const totalDays = daysBetween(periodStart, periodEnd);
  if (totalDays <= 0) {
    return 0;
  }
  const remainingMs = toDate(periodEnd).getTime() - toDate(switchDate).getTime();
  if (remainingMs <= 0) {
    return 0;
  }
  const remainingDays = remainingMs / MS_PER_DAY;
  const diff = Number(newPriceCents) - Number(oldPriceCents);
  if (!Number.isFinite(diff)) {
    return 0;
  }
  return Math.round((diff * remainingDays) / totalDays);
}

// 试用期结束转换:`trialing` → `active`,周期推一个完整 interval,产出本周期的 invoice payload。
// 调用方负责在 store 中写入新 subscription 状态与 invoice。
export function endTrial({ subscription, plan, now }) {
  if (subscription.status !== "trialing") {
    throw new BillingError(
      `subscription ${subscription.id} is not trialing`,
      409,
      "invalid_state",
    );
  }
  const periodStart = toDate(now);
  const periodEnd = addInterval(periodStart, plan.interval);
  return {
    subscription: {
      ...subscription,
      status: "active",
      trial_end: subscription.trial_end ?? toIso(now),
      current_period_start: toIso(periodStart),
      current_period_end: toIso(periodEnd),
      updated_at: toIso(now),
    },
    invoice: {
      subscription_id: subscription.id,
      customer_id: subscription.customer_id,
      plan_id: plan.id,
      amount_cents: plan.price_cents,
      status: "open",
      period_start: toIso(periodStart),
      period_end: toIso(periodEnd),
      issued_at: toIso(now),
      prorated: false,
      description: `Subscription ${plan.id} after trial`,
    },
  };
}

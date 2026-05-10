# subscription-billing-js

极简 SaaS 订阅计费服务,基于 Node.js 标准库 `http` 实现。
支持 Plan(按月/按年定价 + 试用天数)、Subscription(trialing/active/past_due/canceled 状态机)、
Invoice(open/paid/void)三个核心实体,带 proration 升降级、试用结束自动转换、
period 末取消等关键场景。不依赖任何第三方包。

## 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 返回 `{"ok":true}` |
| GET | `/plans` | 列出全部 plan(按 `id` 升序) |
| POST | `/plans` | 创建/覆盖 plan,201 |
| GET | `/plans/{id}` | 单个 plan 详情;不存在返 404 + `code:"plan_not_found"` |
| GET | `/subscriptions` | 列出订阅,可加 `?customer_id=` `?status=trialing\|active\|past_due\|canceled` |
| POST | `/subscriptions` | 新订阅:`{customer_id, plan_id}`;有试用 → trialing 不开 invoice;无试用 → active + 1 张 open invoice;201 |
| GET | `/subscriptions/{id}` | 单个订阅 |
| POST | `/subscriptions/{id}/cancel` | `{at_period_end:true}` (默认) → 仅置 `cancel_at_period_end=true`;`false` → 立即 `status="canceled"`;200 |
| POST | `/subscriptions/{id}/change-plan` | `{plan_id, prorate:true}` 切换 plan,prorate 时按剩余天数计算 prorated invoice;200 |
| GET | `/invoices` | 列出全部 invoice,可加 `?subscription_id=` `?customer_id=` `?status=` |
| POST | `/invoices/preview` | `{subscription_id, plan_id}` 预览换 plan 的 prorated 金额,不入库 |

## 数据模型

### Plan

`POST /plans` 请求体示例:

```json
{
  "id": "enterprise",
  "name": "Enterprise",
  "price_cents": 49900,
  "interval": "year",
  "trial_days": 30,
  "features": ["custom SLA", "dedicated CSM"]
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | 3-32 字符,小写字母开头,允许 `[a-z0-9-]` |
| `name` | string | 是 | 1-200 字符 |
| `price_cents` | int | 是 | 非负整数,单位 cent |
| `interval` | string | 是 | `month` 或 `year`(`addInterval` 内分别按 30/365 天换算) |
| `trial_days` | int | 否 | 默认 0,范围 0-365 |
| `features` | string[] | 否 | 默认 `[]` |

### Subscription

`POST /subscriptions` 请求体:

```json
{
  "customer_id": "cus_alice",
  "plan_id": "starter"
}
```

返回 `{ subscription, invoice }`(无试用的 plan 才有 invoice)。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | `sub_` + 8 位 hex |
| `customer_id` | string | 1-64 字符,`[a-zA-Z0-9_-]+` |
| `plan_id` | string | 必须存在 |
| `status` | string | `trialing` / `active` / `past_due` / `canceled` |
| `trial_end` | ISO\|null | 有试用时 = `now + trial_days * 1day`,否则 `null` |
| `current_period_start` / `current_period_end` | ISO | trialing 时 end = trial_end;active 时 end = `addInterval(start, plan.interval)` |
| `cancel_at_period_end` | bool | period 末取消时为 `true` |
| `canceled_at` | ISO\|null | 立即取消时记 now |

### Invoice

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | `inv_` + 8 位 hex |
| `subscription_id` / `customer_id` / `plan_id` | string | 来源订阅 |
| `amount_cents` | int | 升级 prorated 为正,降级 prorated 为负 |
| `status` | string | `draft` / `open` / `paid` / `void`,新建默认 `open` |
| `period_start` / `period_end` | ISO | 当前 period 区间 |
| `prorated` | bool | proration 升降级时为 `true`,初始/试用结束开的票为 `false` |
| `description` | string | 人类可读说明 |

## 默认数据

启动后内存中已有 3 个 plan + 1 个 active subscription + 1 张 open invoice,直接验证用:

| plan_id | price_cents | interval | trial_days |
| --- | ---: | --- | ---: |
| `starter` | 900 | month | 14 |
| `pro` | 2900 | month | 0 |
| `team` | 9900 | month | 0 |

| subscription | customer | plan | status |
| --- | --- | --- | --- |
| `sub_xxxx`(启动时随机生成) | `cus_demo` | `pro` | `active` |

启动后 `GET /subscriptions` 即可拿到 `cus_demo` 的 sub id 用于后续 change-plan / cancel 验证。

## Proration 公式

```
total_days     = round((period_end - period_start) / 1d)
remaining_days = (period_end - switch_date) / 1d   // 浮点
amount_cents   = round((new_price - old_price) * remaining_days / total_days)
```

边界:`total_days <= 0` 或 `remaining_days <= 0` 时返回 `0`;`new_price === old_price` 时返回 `0`。
升级返回正数(应补差),降级返回负数(应退款)。

## 投票 / 状态机规则

`POST /subscriptions` 校验顺序:

1. `customer_id` 不匹配 `^[a-zA-Z0-9_-]{1,64}$` → 400 + `code:"invalid_customer_id"`
2. `plan_id` 不存在 → 404 + `code:"plan_not_found"`
3. 同 `customer_id + plan_id` 已有 trialing/active/past_due 订阅 → 409 + `code:"duplicate_subscription"`
4. plan.trial_days > 0 → 创建 trialing,`trial_end = now + trial_days * 1d`,不开 invoice
5. plan.trial_days = 0 → 创建 active + 1 张 open invoice

`POST /subscriptions/{id}/cancel` 校验顺序:

1. 订阅不存在 → 404
2. 订阅已 `status="canceled"` → 409 + `code:"already_canceled"`
3. `at_period_end=true`(默认)→ 仅置 `cancel_at_period_end=true`,status 不变,canceled_at 仍为 null
4. `at_period_end=false` → status 立即置 `canceled`,canceled_at 记 now

`POST /subscriptions/{id}/change-plan` 校验顺序:

1. 订阅不存在 → 404
2. 订阅已 canceled → 409 + `code:"subscription_canceled"`
3. 目标 plan 不存在 → 404
4. 目标 plan === 当前 plan → 409 + `code:"same_plan"`
5. prorate=true(默认)且 `prorationCents !== 0` → 写一张 prorated open invoice
6. prorate=false → 仅切 plan_id,不开 invoice(下个周期再按新价开)

## 本地运行

本机需要 Node.js 20 或更高版本。项目只用标准库,不需要 `npm install`。

```bash
npm test
npm start
```

默认监听 `0.0.0.0:8797`,可以通过 `PORT` 覆盖:

```bash
PORT=18797 npm start
```

## 请求示例

健康检查:

```bash
curl http://127.0.0.1:8797/health
```

新订阅(alice 订阅 14 天试用的 starter):

```bash
curl -X POST http://127.0.0.1:8797/subscriptions \
  -H 'content-type: application/json' \
  -d '{"customer_id":"cus_alice","plan_id":"starter"}'
```

预览 cus_demo 从 pro 升 team 的 prorated 金额:

```bash
curl -X POST http://127.0.0.1:8797/invoices/preview \
  -H 'content-type: application/json' \
  -d '{"subscription_id":"sub_xxxx","plan_id":"team"}'
```

## 关键文件

- `src/server.js`:入口,从 `PORT` 环境变量读端口(默认 8797),`http.createServer` + `createRouter()`
- `src/router.js`:HTTP 路由,基于 `URL` + 正则前后缀切片,`createRouter` 返回 async handler
- `src/store.js`:`BillingStore` 类、`normalizePlan` / `createDefaultStore`、PLAN_ID_PATTERN / CUSTOMER_ID_PATTERN / SUBSCRIPTION_STATUSES / INVOICE_STATUSES
- `src/billing.js`:`prorationCents` / `addInterval` / `daysBetween` / `endTrial` 纯函数,`BillingError` 异常,`MS_PER_DAY` / `DAYS_PER_MONTH` / `DAYS_PER_YEAR` / `INTERVALS` 常量
- `tests/billing.test.js`:proration / addInterval / endTrial 等纯函数用例
- `tests/store.test.js`:模型校验、createSubscription、cancel、change-plan、preview、listInvoices 等
- `tests/router.test.js`:HTTP 端到端,含 status 过滤、duplicate 拒收、preview 不入库

## Docker 环境

确保 Docker Desktop 已启动。

```bash
docker build -t subscription-billing-js .
docker run --rm -p 8797:8797 subscription-billing-js
```

服务启动后:

```bash
curl http://127.0.0.1:8797/health
# 预期 {"ok":true}
```

容器内验证:

```bash
docker run --rm subscription-billing-js npm test
docker run --rm subscription-billing-js pwd       # /app
docker run --rm subscription-billing-js git status --short  # 干净
```

## 常见问题

### 为什么数据会在重启后丢失?

当前实现使用进程内 `Map` / 数组保存 plans / subscriptions / invoices,容器或进程重启后会回到默认 fixture。
后续可以把 `BillingStore` 替换为 SQLite / Postgres 实现。

### 为什么 month/year 分别按 30/365 天换算?

为了避免月底 + 闰年带来的边界 bug,`addInterval` 直接做"加固定天数"的简化处理。
真实计费场景下应该按真实的"自然月" / "自然年" 来计算 period,需要换 `Temporal` 或者 `date-fns` 实现。

### change-plan 之后 current_period_end 会变吗?

不会。`change-plan` 只改 `plan_id` 与可选的 prorated invoice,
保留 `current_period_start` / `current_period_end` 不变,
意味着升级是"立即生效但本期补差,下期按新价开",降级则按"本期已付按比例返,下期按新价开"。

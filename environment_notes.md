# 环境说明

- 项目语言:JavaScript,运行在 Node.js 20+
- Docker 基础镜像:`node:22-bookworm`
- 容器工作目录:`/app`
- 构建时会把项目根目录的仓库文件复制到 `/app`
- 项目只使用 Node.js 标准库,因此不需要 `npm install`
- 默认启动命令:`npm start`,监听 `0.0.0.0:8797`
- 默认验证命令:`npm test`(node:test)
- HTTP 端点:`GET /health`、`GET /plans`、`POST /plans`、`GET /plans/{id}`、`GET /subscriptions`、`POST /subscriptions`、`GET /subscriptions/{id}`、`POST /subscriptions/{id}/cancel`、`POST /subscriptions/{id}/change-plan`、`GET /invoices`、`POST /invoices/preview`
- 默认三个 plan:`pro`(price_cents=2900,interval=month,trial_days=0)、`starter`(price_cents=900,interval=month,trial_days=14)、`team`(price_cents=9900,interval=month,trial_days=0)
- 默认 1 个 subscription + 1 张 paid invoice:`cus_demo` 订阅 `pro`,启动时通过 `createSubscription` 自动写入
- Dockerfile 会把 `/app` 初始化为 `main` 分支 Git 仓库,并创建一个初始提交

## 手动验证命令

```bash
docker build -t subscription-billing-js .
docker run --rm -d -p 8797:8797 --name subscription-billing-qc subscription-billing-js
curl http://127.0.0.1:8797/health
curl http://127.0.0.1:8797/plans
curl -X POST http://127.0.0.1:8797/subscriptions \
  -H 'content-type: application/json' \
  -d '{"customer_id":"cus_alice","plan_id":"starter"}'
curl -X POST http://127.0.0.1:8797/invoices/preview \
  -H 'content-type: application/json' \
  -d '{"subscription_id":"<sub_demo_id>","plan_id":"team"}'
curl -X POST http://127.0.0.1:8797/subscriptions/<sub_demo_id>/change-plan \
  -H 'content-type: application/json' \
  -d '{"plan_id":"team"}'
curl http://127.0.0.1:8797/invoices
docker stop subscription-billing-qc
docker run --rm subscription-billing-js npm test
docker run --rm subscription-billing-js pwd
docker run --rm subscription-billing-js git status --short
```

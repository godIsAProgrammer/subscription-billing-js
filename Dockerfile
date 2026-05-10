FROM node:22-bookworm

# 订阅计费服务只依赖 Node.js 标准库,所有源码、测试和 package.json 都在 /app 下运行。
WORKDIR /app

# 复制路由、Plan/Subscription/Invoice 模型和 node:test 用例,作为评审看到的初始代码现场。
COPY . /app/

# 先跑 billing/store/router 测试,把通过验证的项目固化为 Git 初始提交。
RUN npm test \
    && git init -b main \
    && git config user.email "agent@example.invalid" \
    && git config user.name "Agent Fixture" \
    && git add . \
    && git commit -m "Initial subscription billing fixture"

EXPOSE 8797

# 容器默认启动订阅计费 HTTP 服务,质检可通过 /health 与业务接口验证运行状态。
CMD ["npm", "start"]

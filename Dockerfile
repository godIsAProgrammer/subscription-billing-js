FROM node:22-bookworm

# 订阅计费服务只依赖 Node.js 标准库,上传包中源码位于 repo/ 下。
WORKDIR /app

# 质检构建上下文为 Dockerfile + repo/,这里只初始化运行环境,不执行测试或 Git 初始化。
COPY repo/ .

EXPOSE 8797

# 容器默认启动订阅计费 HTTP 服务,质检可通过 /health 与业务接口验证运行状态。
CMD ["npm", "start"]

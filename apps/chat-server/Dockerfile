# syntax=docker/dockerfile:1.6
#
# 镜像：utlra/chat-server
# 构建上下文：仓库根（必须从根目录 `docker build -f apps/chat-server/Dockerfile .` 或通过 compose）
#
# 阶段 1：安装全部依赖并构建 webchat-protocol + chat-server
# 阶段 2：仅复制运行所需的产物 + 生产依赖
FROM node:20-alpine AS builder
WORKDIR /repo

# 复制工作区清单（先单独 COPY 以利用 docker cache）
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/webchat-protocol/package.json packages/webchat-protocol/
COPY apps/chat-server/package.json apps/chat-server/

# 这里 ci 不能用：仓库其它工作区没有 package.json 同步在镜像里。
# 用 install + --workspaces=false 之外的额外步骤太复杂，直接全量 install。
RUN npm install --include=dev --workspace=@utlra/webchat-protocol --workspace=@utlra/chat-server --include-workspace-root

# 拷源码（仅与 chat-server 直接相关的工作区）
COPY packages/webchat-protocol packages/webchat-protocol
COPY apps/chat-server apps/chat-server

RUN npm run build -w @utlra/webchat-protocol \
 && npm run build -w @utlra/chat-server

# ── 运行镜像 ──────────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /repo

COPY package.json package-lock.json* ./
COPY packages/webchat-protocol/package.json packages/webchat-protocol/
COPY apps/chat-server/package.json apps/chat-server/

RUN npm install --omit=dev --workspace=@utlra/webchat-protocol --workspace=@utlra/chat-server --include-workspace-root

COPY --from=builder /repo/packages/webchat-protocol/dist packages/webchat-protocol/dist
COPY --from=builder /repo/apps/chat-server/dist apps/chat-server/dist

# 持久化卷：用户、线程、消息、上传文件、auth.json 全部落在 /data
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]
ENV CHAT_SERVER_DATA_ROOT=/data
ENV WEBCHAT_AUTH_DATA_FILE=/data/auth.json
ENV NODE_ENV=production
ENV PORT=8790

USER node
EXPOSE 8790

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:8790/healthz || exit 1

CMD ["node", "apps/chat-server/dist/index.js"]

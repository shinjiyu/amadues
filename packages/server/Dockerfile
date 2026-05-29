# syntax=docker/dockerfile:1.6
#
# 镜像：utlra/agent-server
# 构建（仓库根）：
#   docker build -f packages/server/Dockerfile -t utlra/agent-server:latest .
#
# Agent 在容器内运行：shell_exec / 内脑仅能访问容器文件系统；
# 持久化数据挂载到 /data（UTLRA_DATA_ROOT=/data）。
FROM node:20-bookworm-slim AS builder
WORKDIR /repo

COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/chat-ir/package.json packages/chat-ir/
COPY packages/discord-bridge/package.json packages/discord-bridge/
COPY packages/webchat-protocol/package.json packages/webchat-protocol/
COPY packages/webchat-bridge/package.json packages/webchat-bridge/
COPY packages/server/package.json packages/server/

RUN npm install --include=dev \
  --workspace=@utlra/chat-ir \
  --workspace=@utlra/discord-bridge \
  --workspace=@utlra/webchat-protocol \
  --workspace=@utlra/webchat-bridge \
  --workspace=@utlra/server \
  --include-workspace-root

COPY packages/chat-ir packages/chat-ir
COPY packages/discord-bridge packages/discord-bridge
COPY packages/webchat-protocol packages/webchat-protocol
COPY packages/webchat-bridge packages/webchat-bridge
COPY packages/server packages/server

RUN npm run build -w @utlra/chat-ir \
 && npm run build -w @utlra/discord-bridge \
 && npm run build -w @utlra/webchat-protocol \
 && npm run build -w @utlra/webchat-bridge \
 && npm run build -w @utlra/server

# ── 运行镜像 ──────────────────────────────────────────────────────
FROM node:20-bookworm-slim

# curl：web_search 默认引擎；git：workspace 内 isomorphic-git
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

COPY package.json package-lock.json* ./
COPY packages/chat-ir/package.json packages/chat-ir/
COPY packages/discord-bridge/package.json packages/discord-bridge/
COPY packages/webchat-protocol/package.json packages/webchat-protocol/
COPY packages/webchat-bridge/package.json packages/webchat-bridge/
COPY packages/server/package.json packages/server/

RUN npm install --omit=dev \
  --workspace=@utlra/chat-ir \
  --workspace=@utlra/discord-bridge \
  --workspace=@utlra/webchat-protocol \
  --workspace=@utlra/webchat-bridge \
  --workspace=@utlra/server \
  --include-workspace-root

COPY --from=builder /repo/packages/chat-ir/dist packages/chat-ir/dist
COPY --from=builder /repo/packages/discord-bridge/dist packages/discord-bridge/dist
COPY --from=builder /repo/packages/webchat-protocol/dist packages/webchat-protocol/dist
COPY --from=builder /repo/packages/webchat-bridge/dist packages/webchat-bridge/dist
COPY --from=builder /repo/packages/server/dist packages/server/dist

RUN mkdir -p /data && chown -R node:node /data

VOLUME ["/data"]
ENV NODE_ENV=production
ENV UTLRA_DATA_ROOT=/data
ENV PORT=8787
ENV TZ=Asia/Shanghai

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/api/health || exit 1

CMD ["node", "packages/server/dist/index.js"]

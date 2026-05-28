# syntax=docker/dockerfile:1.6
#
# 镜像：utlra/web-chat
# 构建上下文：仓库根（与 chat-server Dockerfile 同源；compose 自动设置）
#
# 阶段 1：构建静态产物
# 阶段 2：nginx alpine 静态服务（仅服务静态资源；外层 nginx 负责 SSL/路由）
FROM node:20-alpine AS builder
WORKDIR /repo

ARG VITE_BASE=/webchat/
ENV VITE_BASE=$VITE_BASE

COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/webchat-protocol/package.json packages/webchat-protocol/
COPY apps/web-chat/package.json apps/web-chat/

RUN npm install --include=dev --workspace=@utlra/webchat-protocol --workspace=@utlra/web-chat --include-workspace-root

COPY packages/webchat-protocol packages/webchat-protocol
COPY apps/web-chat apps/web-chat

RUN npm run build -w @utlra/webchat-protocol \
 && VITE_BASE=$VITE_BASE npm run build -w @utlra/web-chat

# ── 运行镜像 ──────────────────────────────────────────────────────
FROM nginx:alpine

COPY --from=builder /repo/apps/web-chat/dist /usr/share/nginx/html
COPY apps/web-chat/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:8080/health || exit 1

CMD ["nginx", "-g", "daemon off;"]

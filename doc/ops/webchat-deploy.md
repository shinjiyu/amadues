# WebChat 子路径部署（通用）

将 `apps/chat-server` + `apps/web-chat` 以子路径（如 `/webchat/`）挂在现有 HTTPS 站点后。

> **这是聊天服务器，不是 Agent。** 必须先部署并运行 chat-server，再启动 Agent 容器。模块划分与 OpenClaw 一体化 Web UI 不同，见 **[startup-order.md](../deploy/startup-order.md)**。

**English summary:** build dual containers (API + static H5), set `WEBCHAT_PUBLIC_BASE_PATH` and nginx `location` blocks, align agent env `WEBCHAT_*` with server secret and agent user ids. **Start this before agents.**

---

## 架构

```
Browser ──► HTTPS reverse proxy
              ├── /webchat/      → static H5 (web-chat)
              ├── /webchat/api/  → chat-server REST
              ├── /webchat/ws    → chat-server WebSocket
              └── /webchat/uploads/ → chat-server uploads
```

Agent 容器通过公网或内网 URL 连接同一 chat-server（**chat-server 须先就绪**，见 [startup-order.md](../deploy/startup-order.md)、[agent-quickstart.md](../deploy/agent-quickstart.md)）。

---

## Compose

参考 `deploy/webchat/docker-compose.webchat.yml`（单环境）或 `docker-compose.webchat.dual.yml`（多环境、多子路径）。

```bash
cp deploy/webchat/.env.example deploy/webchat/.env
# 编辑 WEBCHAT_AGENT_SECRET、登录与白名单等
docker compose -f deploy/webchat/docker-compose.webchat.yml \
  --env-file deploy/webchat/.env up -d --build
```

---

## Nginx

参考 `deploy/nginx/webchat-subpath.conf`：将 `location` 合并进你的 `server { }`，`nginx -t && reload`。

---

## Agent 对齐

每个 Agent 实例 env 中：

- `WEBCHAT_API_BASE` / `WEBCHAT_WS_URL` 指向上述 API / WS
- `WEBCHAT_AGENT_SECRET` 与 server 相同
- `WEBCHAT_AGENT_USER_ID` 在 server 的保留 agent id 列表中

---

## 认证

生产环境建议 `WEBCHAT_AUTH_REQUIRED=1`，并与现有登录服务同 origin 或按 [channel-bridge-guide.md](../channel-bridge-guide.md) 配置回调。

---

## 本地开发

```bash
npm run dev:webchat-all   # chat-server + H5，默认开发端口见各 app 的 package.json
```

具体域名、证书、双环境端口映射等 **机器相关** 说明请放在 `doc/ops/local/`（不提交仓库）。

# 部署顺序与模块划分

Amadues **不是** OpenClaw 那种「一个 Web UI 里嵌 Agent」的一体化产品。聊天中枢与 Agent 是**两个独立可部署模块**，必须按顺序启动。

English summary: start **chat-server** (IM hub) first, then **agent** container(s). Web UI ≠ agent API; unlike OpenClaw’s integrated web UI.

---

## 1. 与 OpenClaw 的区别

| | **OpenClaw（常见形态）** | **Amadues** |
|---|--------------------------|-------------|
| 聊天界面 | 常与 Agent 同进程 / 同 Web UI | **独立** `apps/web-chat`（H5 客户端） |
| 消息枢纽 | 内置在 Gateway / UI 后端 | **独立** `apps/chat-server`（REST + WebSocket） |
| Agent 运行时 | 与 UI 紧耦合 | **独立** `packages/server`（外脑 + 内脑 spawn，Hono API） |
| 运维监控 | 多合一 | **可选** `apps/dashboard`（只读，**不能**用来聊天） |

在 Amadues 里：

- 用户在浏览器里聊的是 **WebChat → chat-server**
- Agent 是 **后台工作者**，通过 `webchat-bridge` 连到 chat-server，**不会**因为启动了 Agent 就自动出现聊天页
- `apps/dashboard` 只看内脑 / 外脑 / 用量，**不是** IM 客户端

---

## 2. 三个模块（请先认清再部署）

```text
┌─────────────────────────────────────────────────────────────┐
│ ① Chat 层（先启动）                                          │
│    apps/chat-server   REST + WS，消息持久化、鉴权、多租户     │
│    apps/web-chat      可选 H5 前端，连 chat-server            │
└───────────────────────────────┬─────────────────────────────┘
                                │ HTTP / WebSocket
                                ▼
┌─────────────────────────────────────────────────────────────┐
│ ② Agent 层（后启动，可多个实例）                              │
│    packages/server    外脑 / 内脑 / 工具 / LLM               │
│    webchat-bridge     Agent 进程内的渠道适配（连 ①）          │
│    每实例：独立 Docker 容器 + data-<instance>/ 数据卷          │
└───────────────────────────────┬─────────────────────────────┘
                                │ 只读 HTTP（可选）
                                ▼
┌─────────────────────────────────────────────────────────────┐
│ ③ 运维 Dashboard（可选，随时可启）                            │
│    apps/dashboard     监控 API，不处理用户聊天                 │
└─────────────────────────────────────────────────────────────┘
```

Discord 渠道时：**没有** chat-server，Agent 直连 Discord Gateway（见 [channel-bridge-guide.md](../channel-bridge-guide.md)）。下文 WebChat 路径才需要 ①。

---

## 3. 推荐启动顺序（WebChat）

### Step 0 — 构建（一次性）

```bash
cd <repo-root>
npm install
npm run build
```

### Step 1 — 启动聊天服务器（必须先于 Agent）

**本地开发：**

```bash
npm run dev:webchat-all    # chat-server + web-chat
```

**生产 / Docker：**

见 [webchat-deploy.md](../ops/webchat-deploy.md)：

```bash
cp deploy/webchat/.env.example deploy/webchat/.env
# 编辑 WEBCHAT_AGENT_SECRET、白名单等
docker compose -f deploy/webchat/docker-compose.webchat.yml \
  --env-file deploy/webchat/.env up -d --build
```

验收：浏览器能打开 H5；`curl` chat-server 健康或登录接口正常。

### Step 2 — 配置 Agent env

复制并编辑 `deploy/agent/env/<instance>.env`：

- `UTLRA_CHAT_CHANNEL=webchat`
- `WEBCHAT_API_BASE` / `WEBCHAT_WS_URL` → **Step 1 的 chat-server 地址**
- `WEBCHAT_AGENT_SECRET` → 与 chat-server **完全相同**
- `WEBCHAT_AGENT_USER_ID` → 在 server 保留 agent id 列表中
- LLM Key；**推荐** [mem9 / drive9](./mem9-drive9-credentials.md)

详见 [agent-quickstart.md](./agent-quickstart.md)。

### Step 3 — 启动 Agent（chat-server 已就绪后）

```bash
npm run docker:agents:build
docker compose -f deploy/agent/docker-compose.agent.yml \
  --profile <instance> up -d --build
```

验收：

```bash
curl -fsS http://127.0.0.1:<agent-port>/api/health
# Agent 日志：webchat channel ready (online)
```

在 WebChat 里 @ Agent 或发消息，应有回复。

### Step 4 — 可选：运维 Dashboard

```bash
npm run dev:dashboard
```

仅用于看内脑 / 外脑 / Token 用量，**不能**替代 Step 1 的聊天界面。

---

## 4. 常见错误

| 现象 | 原因 |
|------|------|
| Agent 启动报 WebChat 连接失败 | **先启了 Agent，chat-server 未起**或 URL/Secret 不对 |
| 浏览器没有聊天页 | 只起了 Agent，**未起** `web-chat` + `chat-server` |
| 把 Dashboard 当聊天 UI | Dashboard 是运维面板，不是 IM |
| 多个 Agent 抢同一 `WEBCHAT_AGENT_USER_ID` | 每实例 user id 必须不同 |

---

## 5. 相关文档

| 文档 | 内容 |
|------|------|
| [webchat-deploy.md](../ops/webchat-deploy.md) | chat-server + H5 部署 |
| [agent-quickstart.md](./agent-quickstart.md) | Agent Docker 与 env |
| [mem9-drive9-credentials.md](./mem9-drive9-credentials.md) | 记忆 / 技能库 Key |
| [channel-bridge-guide.md](../channel-bridge-guide.md) | Discord / WebChat 桥接细节 |
| [architecture.md](../architecture.md) | 架构总览 |

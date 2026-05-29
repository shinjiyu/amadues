# Kuroneko（依莉雅）

> **语言 / Language:** 中文（本页）· [English](./README.en.md)

绿场 Agent 栈：**数据落地**、**身份 + Chat IR**、**外脑 / 内脑（Pi-mono）**、**Web 仪表盘**与 **WebChat H5**。产品名 **依莉雅（Kuroneko / Ilya）**。

设计文档索引：[`doc/README.md`](./doc/README.md)（架构、内外脑协议、渠道桥、测试、Structurizr ADL、运维）。

## 要求

- Node.js ≥ 20
- Docker（运行 Agent 容器）

## 本地服务一览

| 服务 | 命令 / 说明 | 地址 |
|------|-------------|------|
| **Kuroneko Agent** | `npm run docker:agents:up:kuroneko` | API http://127.0.0.1:8787 |
| **Shiro Agent** | `npm run docker:agents:up:shiro` | API http://127.0.0.1:8788 |
| **Gin Agent** | `npm run docker:agents:up:gin` | API http://127.0.0.1:8789 |
| **Aoi Agent** | `npm run docker:agents:up:aoi` | API http://127.0.0.1:8791 |
| **Dashboard** | `npm run dev:dashboard` | http://127.0.0.1:5173（`/api`→8787，`/api2`→8788，`/api3`→8789，`/api4`→8791） |
| **Chat Server** | `npm run dev:chat-server` | http://127.0.0.1:8790 |
| **Web Chat H5** | `npm run dev:web-chat` | http://127.0.0.1:5180 |
| **Ops Console** | `npm run dev:ops` | http://127.0.0.1:7779（三 Agent 日志） |
| **local-dashboard** | 见下「9780 总控」 | http://127.0.0.1:9780/?page=kuroneko（**启停**上面各项进程） |

### 9780 总控（local-dashboard）

与 **5173 Dashboard** 不同：9780 只管**开/关服务**，不看内脑文件。新增 Gin 后需同步一次注册表：

```powershell
.\scripts\sync-local-dashboard.ps1
# 浏览器打开 http://127.0.0.1:9780/?page=kuroneko → 可启停 Agent: Gin (8789) 等
```

详见 [`doc/ops/local-dashboard.md`](./doc/ops/local-dashboard.md)。

## 安装与开发

```powershell
cd <repo-root>
# 为每个 agent 准备 deploy/agent/env/<name>.env（见 deploy/agent/env/*.example）
npm install
npm run build
npm run docker:agents:up    # 四 Agent（Docker）
npm run dev:dashboard       # 业务 Dashboard
```

常用命令：

```powershell
npm run docker:agents:up          # 四 Agent 全部
npm run docker:agents:up:aoi      # 仅 Aoi
npm run docker:agents:down        # 停止全部 Agent 容器
npm run dev:dashboard             # 业务 Dashboard（5173）
npm run dev:webchat-all           # 本地 chat-server + H5（可选，与 agent 无关）
npm run dev:ops                   # Ops 日志台
```

配置说明见 [`doc/ops/agent-docker.md`](./doc/ops/agent-docker.md)。**Agent 仅支持 Docker 启动**，不再提供 `dev:server` / `dev:agent2` 等本机进程模式。

**离线调试**（未配渠道时）：`POST http://127.0.0.1:8787/api/outer/roundtrip` 触发外脑 roundtrip，写入 `<UTLRA_DATA_ROOT>/chat/threads.json`。

## LLM 配置（`.env` / `.env.agent2`）

至少配置 **一种** 文本模型（详见 [`.env.example`](./.env.example)）：

| Provider | 典型变量 | 说明 |
|----------|----------|------|
| **智谱 GLM** | `ZHIPU_API_KEY`、`ZHIPU_MODEL=glm-5.1` | Coding Plan 须用 `ZHIPU_BASE_URL=https://open.bigmodel.cn/api/coding/paas/v4` |
| **LocalModule** | `LOCALMODULE_API_KEY`、`UTLRA_INNER_LLM_PROVIDER=localmodule` | OpenAI 兼容端点 |
| **Kimi** | `KIMI_API_KEY` | Moonshot OpenAI 兼容 |

**切勿**把 `.env` / `.env.agent2` 提交到 Git；Key 泄露请在控制台立即轮换。

自测：`npm run smoke:zhipu` / `npm run smoke:zhipu:vision`。

## Pi-mono 内脑

Pi-mono 运行时 **内嵌** 于 `packages/server/src/openkuroneko/`，实现 **DECOMPOSE / EXECUTE / ATTRIBUTE / AWAITING** 等控制器。**无需** 外部 `OPENKURONEKO_DIST`。

- **单步**：`POST /api/inner/:ws/pi-tick`
- **Auto burst**：`POST /api/inner/:ws/pi-auto`，body `{ "maxTicks": 500 }`
- Goal 权威路径：`.brain/goal.md`

Dashboard **内脑** 页可设 Goal、Tick、看状态。

## 外脑与 Repository

- `GET /api/outer/inner-status/:ws` — 内脑聚合状态  
- `POST /api/outer/roundtrip` — 设 Goal → 子进程跑 Pi-mono Auto → `StructuredReply`  
- `POST /api/outer/workspace/:ws/shutdown` — 晋升 manifest / 休眠  

规则见 [`doc/inner-outer-protocol.md`](./doc/inner-outer-protocol.md)。

Repository（执行轨 / 交互轨）：`POST /api/repository/:tenant/commit|retrieve`。

## 渠道：Discord / WebChat

- **`@utlra/chat-ir`** — 消息 / 线程 / 身份模型与存储  
- **`@utlra/discord-bridge`** — `UTLRA_CHAT_CHANNEL=discord` + `DISCORD_BOT_TOKEN`  
- **`@utlra/webchat-bridge`** + **`apps/chat-server`** + **`apps/web-chat`** — `UTLRA_CHAT_CHANNEL=webchat`  

接入说明：[`doc/channel-bridge-guide.md`](./doc/channel-bridge-guide.md)、[`doc/chat-ir-identity-design.md`](./doc/chat-ir-identity-design.md)。

三 Agent 共用 chat-server 时：复制 `.env.chat-server.example` → `.env.chat-server`（`WEBCHAT_AGENT_USER_ID=kuroneko,shiro,gin,aoi`），再 `npm run dev:chat-server`。各 agent 的 `WEBCHAT_AGENT_SECRET` 须一致。

## 测试与架构

```powershell
npm test
npm run test:server:integration
npm run structurizr:check
```

测试约定：[`doc/how-to-write-tests.md`](./doc/how-to-write-tests.md)、[`doc/testing-strategy.md`](./doc/testing-strategy.md)。

## 同步到 Git

见 [`doc/ops/git-workflow.md`](./doc/ops/git-workflow.md)。**勿在文档或聊天中粘贴 Token。**

---

本地运行时数据（`packages/server/data/`、`data-shiro/`、`data-gin/`、`data-aoi/`、`apps/chat-server/data/`）均在 `.gitignore` 中，不会入库。

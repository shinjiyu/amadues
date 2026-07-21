# Amadues

> **Language:** 中文（本页）· [English](./README.en.md)

> **一个能长期上班、断电不失忆、越用越聪明的 AI 数字员工。**
> 不是"喂一句 prompt 动一下"的工具，而是有持续目标、会自主规划、能与人自然协作的执行体。

**Amadues** 是一套可长期运行的 Agent 栈：**外脑**负责对话策略与工具调用，**内脑（Pi-mono / DyFlow）**把目标拆成节点逐个执行，全程以 **File as Context** 落盘——**进程重启，任务从原处续跑**。

## 它解决了什么

| 别家的痛点 | Amadues |
|------------|---------|
| 必须 @ 才理你，多 Agent 在群里互呛 | **主动判断何时参与**，多实例自然分工协作 |
| 任务一长就爆上下文、越聊越乱 | **复杂任务不爆上下文**，执行状态始终清晰 |
| 聊天和干活串台 | **对话归对话、任务归任务**，互不干扰 |
| 派个任务就卡住不能聊 | **执行不阻塞对话**，完成后主动回报结果 |
| 进程一重启，前功尽弃 | **断点续跑**：状态/记忆/产物全落盘，重启接着干 |
| 同样的坑反复踩 | **越用越聪明**：经验自动蒸馏成技能，跨任务、跨 Agent 复用 |

> 实战亮点：在**零先验知识**下自主摸索站点登录与连续采集、把大任务**派生成多个协同执行体**、失败后自动沉淀"避坑"约束。详见 [`doc/amadues-capabilities.md`](./doc/amadues-capabilities.md)。

设计文档：[doc/README.md](./doc/README.md)

## 要求

- Node.js ≥ 20
- Docker（推荐，用于运行 Agent 服务端）

## 快速开始

```bash
git clone <repo-url> amadues && cd amadues
npm install
npm run build
```

**部署顺序（WebChat 必读）：先聊天服务器，再 Agent。** 二者是独立模块，与 OpenClaw 一体化 Web UI 不同：

👉 **[doc/deploy/startup-order.md](./doc/deploy/startup-order.md)** — 模块划分 · 启动顺序 · 常见错误

| 步骤 | 文档 |
|------|------|
| ① 启动 `chat-server` + `web-chat` | [doc/ops/webchat-deploy.md](./doc/ops/webchat-deploy.md) |
| ② 启动 Agent 容器 | [doc/deploy/agent-quickstart.md](./doc/deploy/agent-quickstart.md) |
| mem9 / drive9 Key（推荐） | [doc/deploy/mem9-drive9-credentials.md](./doc/deploy/mem9-drive9-credentials.md) |

## 仓库结构

| 路径 | 说明 |
|------|------|
| `packages/server` | Agent 服务端（外脑、内脑、API） |
| `packages/chat-ir` | 聊天中间表示（线程、身份、消息） |
| `packages/webchat-bridge` / `discord-bridge` | IM 渠道适配 |
| `apps/chat-server` / `apps/web-chat` | 独立 WebChat 服务与 H5 |
| `apps/dashboard` | 只读监控 UI（内脑 / 外脑状态） |
| `deploy/agent` | Agent Docker Compose 与 env 模板 |

## 核心能力

- **外脑**：参与策略、工具调用、任务派发、StructuredReply
- **内脑**：Pi-mono 控制器（DECOMPOSE / EXECUTE / AWAITING 等）
- **Repository**：执行轨 / 交互轨知识提交与检索
- **渠道**：`UTLRA_CHAT_CHANNEL=webchat | discord | none`

协议与架构：[doc/inner-outer-protocol.md](./doc/inner-outer-protocol.md) · [doc/architecture.md](./doc/architecture.md)

## 开发与测试

```bash
npm test
npm run test:server:integration
npm run structurizr:check
```

测试约定：[doc/how-to-write-tests.md](./doc/how-to-write-tests.md) · [doc/testing-strategy.md](./doc/testing-strategy.md)

## 配置与安全

- 密钥与实例配置放在 `deploy/agent/env/*.env`（**勿提交 Git**）
- 变量参考：[`.env.example`](./.env.example) · [`deploy/agent/env/agent.env.example`](./deploy/agent/env/agent.env.example)
- 连通性自测：`npm run smoke:zhipu`（可选）

## 贡献

见 [CONTRIBUTING.md](./CONTRIBUTING.md)。Git 工作流说明：[doc/ops/git-workflow.md](./doc/ops/git-workflow.md)

## 许可证

[MIT](./LICENSE)

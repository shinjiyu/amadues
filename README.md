# Amadues

> **Language:** 中文（本页）· [English](./README.en.md)

**Amadues** 是一套可长期运行的 Agent 栈：持久化数据、Chat IR、外脑 / 内脑（Pi-mono）、可选 WebChat / Discord 渠道，以及运维用 Web 控制台。

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

**部署单个 Agent 实例**（Docker + 环境变量 + 渠道密钥）见：

👉 **[doc/deploy/agent-quickstart.md](./doc/deploy/agent-quickstart.md)**

**mem9 / drive9**（语义记忆与技能库，推荐配置）：

👉 **[doc/deploy/mem9-drive9-credentials.md](./doc/deploy/mem9-drive9-credentials.md)** · [mem9.ai](https://mem9.ai/) · [drive9.ai](https://drive9.ai/)

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

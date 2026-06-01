# 文档索引 / Documentation Index

> **Language:** 中文 · [English README](../README.en.md)  
> **Project:** [Amadues](../README.md)

---

## 快速导航

| 你想… | 文档 |
|--------|------|
| 了解产品 | [`intro.md`](./intro.md) |
| **部署 Agent（一键）** | **[`deploy/agent-quickstart.md`](./deploy/agent-quickstart.md)** |
| **申请 mem9 / drive9 Key** | **[`deploy/mem9-drive9-credentials.md`](./deploy/mem9-drive9-credentials.md)** |
| 架构总览 | [`architecture.md`](./architecture.md) · [`structurizr/docs/overview.md`](./structurizr/docs/overview.md) |
| 外脑 ↔ 内脑 | [`inner-outer-protocol.md`](./inner-outer-protocol.md) |
| 接 Discord / WebChat | [`channel-bridge-guide.md`](./channel-bridge-guide.md) |
| Agent 接入（长文） | [`agent-integration-guide.md`](./agent-integration-guide.md) |
| 测试 | [`how-to-write-tests.md`](./how-to-write-tests.md) · [`testing-strategy.md`](./testing-strategy.md) |
| Git / 贡献 | [`ops/git-workflow.md`](./ops/git-workflow.md) · [CONTRIBUTING.md](../CONTRIBUTING.md) |
| Docker 多实例 | [`ops/agent-docker.md`](./ops/agent-docker.md) |

---

## 1. 产品与入门

| 文档 | 说明 |
|------|------|
| [`intro.md`](./intro.md) | 产品定位与核心能力 |
| [`deploy/agent-quickstart.md`](./deploy/agent-quickstart.md) | Agent Docker 一键部署 |
| [`deploy/mem9-drive9-credentials.md`](./deploy/mem9-drive9-credentials.md) | mem9 / drive9 官方申请与 env 配置 |
| [`agent-integration-guide.md`](./agent-integration-guide.md) | 工具、入站/出站、多实例协作 |

---

## 2. 架构

| 文档 | 说明 |
|------|------|
| [`architecture.md`](./architecture.md) | 实现向节点图 |
| [`architecture-adl-ai-attention.md`](./architecture-adl-ai-attention.md) | ADL 与模块视界 |
| [`agent-data-state-machine.md`](./agent-data-state-machine.md) | 数据即本体、pendings |
| [`structurizr/`](./structurizr/) | C4 / ADL 权威模型 |

---

## 3. 协议

| 文档 | 说明 |
|------|------|
| [`inner-outer-protocol.md`](./inner-outer-protocol.md) | Roundtrip、Goal、burst |
| [`protocols/inner-brain-deliverables.md`](./protocols/inner-brain-deliverables.md) | 内脑产物 → 附件 |
| [`protocols/webchat-wire.md`](./protocols/webchat-wire.md) | WebChat 线协议 |

---

## 4. 渠道与 Chat

| 文档 | 说明 |
|------|------|
| [`channel-bridge-guide.md`](./channel-bridge-guide.md) | `UTLRA_CHAT_CHANNEL` 配置 |
| [`chat-ir-identity-design.md`](./chat-ir-identity-design.md) | Chat IR、身份、mention |
| [`requirements-standalone-chat-server.md`](./requirements-standalone-chat-server.md) | 独立 chat-server 需求 |

---

## 5. 测试

| 文档 | 说明 |
|------|------|
| [`testing-strategy.md`](./testing-strategy.md) | 分层与 FakeLLM |
| [`how-to-write-tests.md`](./how-to-write-tests.md) | 动手写测 |
| [`reports/`](./reports/) | 测试报告快照 |

---

## 6. 运维（公开）

| 文档 | 说明 |
|------|------|
| [`ops/agent-docker.md`](./ops/agent-docker.md) | Agent 容器与 env 布局 |
| [`ops/git-workflow.md`](./ops/git-workflow.md) | Git 与勿入库清单 |
| [`ops/webchat-deploy.md`](./ops/webchat-deploy.md) | WebChat 子路径部署（通用） |

机器相关的端口、域名、本机总控面板等说明请放在 **`doc/ops/local/`**（该目录默认不提交，见 [local/README.example.md](./ops/local/README.example.md)）。

---

## 7. 设计草案 / 待办

| 文档 | 说明 |
|------|------|
| [`greenfield-milestones.md`](./greenfield-milestones.md) | 里程碑 |
| [`todo/`](./todo/) | 已定稿待实现规格 |

---

## 维护约定

1. 公开文档使用 **Amadues** 项目名；勿写入具体 Agent 角色名、内网 IP、个人域名。  
2. ADL 变更：先改 `structurizr/workspace.dsl`，再 `npm run structurizr:check`。  
3. 根目录 `README.md` 与 `README.en.md` 同步更新。

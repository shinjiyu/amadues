# 文档索引 / Documentation Index

> **语言 / Language:** 中文（本页）· 根目录 [English README](../README.en.md)  
> **Language policy:** 入门与索引类文档提供 **中/英两个文件**（如 `README.md` + `README.en.md`）；长文设计稿以中文为主，文首附 **English summary**（见 [`intro.md`](./intro.md)）。

本目录是 **Kuroneko / 依莉雅** 的设计与操作文档。代码入口：[中文 README](../README.md) · [English README](../README.en.md)。

---

## 快速导航 / Quick navigation

| 你想… / You want to… | 文档 / Doc |
|----------------------|------------|
| 了解产品定位 | [`intro.md`](./intro.md)（中英摘要） |
| 跑起来、配环境 | [README 中文](../README.md#安装与开发) · [README EN](../README.en.md#install--develop) · [`.env.example`](../.env.example) |
| 看系统怎么连起来 | [`architecture.md`](./architecture.md) · [`structurizr/docs/overview.md`](./structurizr/docs/overview.md) |
| 外脑↔内脑、roundtrip | [`inner-outer-protocol.md`](./inner-outer-protocol.md) |
| 接 Discord / WebChat | [`channel-bridge-guide.md`](./channel-bridge-guide.md) |
| 写测试、跑 prompt 套件 | [`how-to-write-tests.md`](./how-to-write-tests.md) · [`testing-strategy.md`](./testing-strategy.md) |
| 本地推 Git（Windows） | [`ops/git-workflow.md`](./ops/git-workflow.md) |
| 启停服务 / 双 Agent 实时日志 | [`ops/local-dashboard.md`](./ops/local-dashboard.md) · `npm run dev:ops` → http://127.0.0.1:7779/ |
| 全量测试报告（快照） | [`reports/test-report-latest.md`](./reports/test-report-latest.md) |

---

## 1. 产品与入门 / Product & onboarding

| 文档 | 说明 |
|------|------|
| [`intro.md`](./intro.md) | 依莉雅要解决什么问题、核心能力（中英摘要） |
| [`agent-integration-guide.md`](./agent-integration-guide.md) | Agent 接入、工具、多 Agent 协作（长文参考） |

---

## 2. 架构 / Architecture

| 文档 | 说明 |
|------|------|
| [`architecture.md`](./architecture.md) | 实现向节点图（Mermaid）；与 ADL 互补 |
| [`architecture-adl-ai-attention.md`](./architecture-adl-ai-attention.md) | ADL + AI 注意力 / 模块视界说明 |
| [`agent-data-state-machine.md`](./agent-data-state-machine.md) | **宪法**：数据即本体、pendings、幂等扩展 |
| [`structurizr/`](./structurizr/) | **ADL 权威**（`workspace.dsl`）、工具链、模块表、测试映射 |

**Structurizr 子目录要点：**

| 文件 | 用途 |
|------|------|
| [`TOOLCHAIN.md`](./structurizr/TOOLCHAIN.md) | `validate` / `local.bat` / 导出图 |
| [`modules-catalog.md`](./structurizr/modules-catalog.md) | L3 模块与 `horizon.*` |
| [`COMPONENT-TEST-MAP.md`](./structurizr/COMPONENT-TEST-MAP.md) | L3 组件 ↔ 测试文件 |
| [`INNER-BRAIN-RESUME.md`](./structurizr/INNER-BRAIN-RESUME.md) | 外脑重启恢复 RUNNING 内脑（ADL + 实现） |
| [`INNER-BRAIN-AWAITING-LIFECYCLE.md`](./structurizr/INNER-BRAIN-AWAITING-LIFECYCLE.md) | AWAITING：registry 对账、IM 必达、changeWatcher bootstrap（设计权威） |
| [`MEMORY-BLOCKS.md`](./structurizr/MEMORY-BLOCKS.md) | Memory Block：keychain=kv_secret、`memory_block_*`（设计权威） |
| [`COMPONENT-TESTING.md`](./structurizr/COMPONENT-TESTING.md) | 组件测试约定 |
| [`REFACTOR-PLAN.md`](./structurizr/REFACTOR-PLAN.md) | P0–P4 架构对齐计划（进行中） |

---

## 3. 协议 / Protocols

| 文档 | 说明 |
|------|------|
| [`inner-outer-protocol.md`](./inner-outer-protocol.md) | 外脑 roundtrip、Goal、burst 后生命周期 |
| [`protocols/inner-brain-deliverables.md`](./protocols/inner-brain-deliverables.md) | 内脑产物 → Chat IR 附件 |
| [`protocols/webchat-wire.md`](./protocols/webchat-wire.md) | 独立 chat-server 线协议 |

> 代码中引用的 `doc/protocols/*.md`（如 `shell-exec-bg`、`logging`）若尚未落盘，以源码注释为准；新增协议请放在 `doc/protocols/`。

---

## 4. 渠道与独立聊天服务 / Channels & chat-server

| 文档 | 说明 |
|------|------|
| [`channel-bridge-guide.md`](./channel-bridge-guide.md) | `UTLRA_CHAT_CHANNEL`、Discord / WebChat 配置 |
| [`chat-ir-identity-design.md`](./chat-ir-identity-design.md) | Chat IR、身份、mention、`StructuredReply` |
| [`requirements-standalone-chat-server.md`](./requirements-standalone-chat-server.md) | 独立 chat-server 需求与 §9 验收 |

---

## 5. 测试 / Testing

| 文档 | 说明 |
|------|------|
| [`testing-strategy.md`](./testing-strategy.md) | 分层：unit / integration / prompt；FakeLLM 原则 |
| [`how-to-write-tests.md`](./how-to-write-tests.md) | 动手写测：fixture、命名、命令 |
| [`reports/`](./reports/) | 全量测试 Markdown 快照（由脚本生成） |

```bash
node scripts/generate-test-report.mjs .tool-outputs/test-report-YYYYMMDD
```

---

## 6. 设计草案与里程碑（历史参考）/ Design drafts & milestones

绿场阶段文档，部分条目已完成；以代码与 Structurizr ADL 为准。

| 文档 | 说明 |
|------|------|
| [`greenfield-milestones.md`](./greenfield-milestones.md) | M0–M9 里程碑清单 |
| [`data-layer-phase1-draft.md`](./data-layer-phase1-draft.md) | 数据层阶段 1 草案 |
| [`verification-async-and-intent.md`](./verification-async-and-intent.md) | 异步验证与意图 |

---

## 7. 运维 / Operations

| 文档 | 说明 |
|------|------|
| [`ops/git-workflow.md`](./ops/git-workflow.md) | Windows 下 `hutao`、推送、凭据 |
| [`ops/local-dashboard.md`](./ops/local-dashboard.md) | 注册到本机 **local-dashboard**（分组 `kuroneko`） |
| [`apps/ops-console`](../apps/ops-console/) | Monorepo 内进程编排（`npm run dev:ops` → 7779） |

---

## 8. 独立子项目文档 / Separate product docs

| 目录 | 说明 |
|------|------|
| [`ad-agency-customer-intelligence/`](./ad-agency-customer-intelligence/) | 广告客户情报系统（与主 Agent 栈独立的需求/技术草案） |

---

## 9. 待办设计 / Design backlog

| 文档 | 说明 |
|------|------|
| [`todo/`](./todo/) | 已定稿、尚未实现的架构/功能规格 |
| [`todo/memory-belief-reconciliation.md`](./todo/memory-belief-reconciliation.md) | 外脑记忆降权修订（Belief / Episodic） |

---

## 10. 包内文档 / Package-local docs

| 路径 | 说明 |
|------|------|
| [`packages/server/docs/`](../packages/server/docs/) | KPI 反思、心跳等实现向设计 |
| [`packages/server/fixtures/README.md`](../packages/server/fixtures/README.md) | 测试 fixture 约定 |

---

## 维护约定 / Maintenance

1. **新增文档**：优先放入上表对应分类；在本文增加一行链接。  
2. **一次性交接稿**（含固定 commit SHA 的 push 说明）不要放在仓库根目录——用 [`ops/git-workflow.md`](./ops/git-workflow.md)。  
3. **ADL 变更**：先改 `structurizr/workspace.dsl`，再跑 `npm run structurizr:check`。  
4. **双语 / Bilingual**  
   - **双文件**：仓库根 `README.md`（中文）+ `README.en.md`（英文）；更新时两文件同步改。  
   - **单文件长文**：中文正文 + 节标题双语；文首 3–5 行 English summary（如 `intro.md`、`doc/ops/local-dashboard.md`）。  
   - **尚未拆英文化** 的架构/协议长文仍以中文为准；需要时可后续加 `*.en.md` 或 summary 块。

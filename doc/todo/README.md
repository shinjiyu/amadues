# 待办设计 / Design backlog

> **English:** Planned features and architecture specs not yet implemented. Linked from [`doc/README.md`](../README.md).

| 文档 | 状态 | 说明 |
|------|------|------|
| [`memory-belief-reconciliation.md`](./memory-belief-reconciliation.md) | **MVP 已完成** | 用户取消/完成 → belief 对账 + tasks/mem9 降权 |
| [`inner-brain-awaiting-lifecycle.md`](./inner-brain-awaiting-lifecycle.md) | **P0+P1 已完成** | AWAITING：reconcile、IM resolver、bootstrap、周期对账、组件测 |
| [`executor-resolved-pendings-truncation.md`](./executor-resolved-pendings-truncation.md) | **已完成** | resolved pending spill（去掉 600 字硬截断） |
| [`cross-agent-research-and-keychain.md`](./cross-agent-research-and-keychain.md) | **R1+R2 已完成** | 研究共享：Attributor write_skill + 重试/BLOCK 兜底 |
| [`memory-blocks-framework.md`](./memory-blocks-framework.md) | **B0–B2 已完成** | Memory Block + keychain + B2 解耦 awaiting/bind |
| [`outer-brain-web-search-tool.md`](./outer-brain-web-search-tool.md) | **待实现** | 外脑专用 Web Search 工具（与内脑 playwright 分离） |
| [`resource-awareness-autonomy.md`](./resource-awareness-autonomy.md) | **ADL 已定稿** | 资源感知 + 心跳闲忙判定 + 自主任务（闲聊 / KPI 内脑 goal） |

**已实现（非 backlog）**：Dashboard **参与策略 Lab** — 外脑「是否回复/插嘴」策略调试台，见下文说明。

维护：讨论定稿后在此登记；实现完成时把状态改为 **已完成** 并链到 ADL/PR。

### 参与策略 Lab（已实现，非 todo）

外脑在群聊/DM 收到消息时，要先决定 **要不要说话**（`inbound-policy.ts` → `decideOuterShouldReply`）：同步规则（@、冷却、频控）+ 可选 LLM 判别 SPEAK/SILENT。

| 组件 | 路径 |
|------|------|
| 决策逻辑 | `packages/server/src/outer/inbound-policy.ts` |
| 群聊频控状态 | `packages/server/src/outer/participation-state.ts` |
| 开发 API | `packages/server/src/api/participation-lab-route.ts`（`/api/dev/participation/*`） |
| 预设用例 | `packages/server/src/api/participation-lab-presets.ts` |
| UI | `apps/dashboard` → 标签 **「参与策略」**（`:5173`），`participation-lab.tsx` |

用途：不调真实 IM。**Mock / 真实 LLM** 时 Lab **强制**调用 `participationSpeakLlm`（同步规则仅展示，并附 `productionFinal` 对比）；**不调 LLM** 则只跑同步规则。需 **重启 server** 后 API 才生效。

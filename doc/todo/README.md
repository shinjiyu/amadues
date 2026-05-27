# 待办设计 / Design backlog

> **English:** Planned features and architecture specs not yet implemented. Linked from [`doc/README.md`](../README.md).

| 文档 | 状态 | 说明 |
|------|------|------|
| [`memory-belief-reconciliation.md`](./memory-belief-reconciliation.md) | **待实现** | 外脑记忆跨时间「降权修订」：Belief / Episodic 分离、取消与完成对账、检索 validity |
| [`inner-brain-awaiting-lifecycle.md`](./inner-brain-awaiting-lifecycle.md) | **待实现** | AWAITING：registry 对账、IM 必达 resolver、changeWatcher bootstrap（设计见 structurizr 专篇） |
| [`executor-resolved-pendings-truncation.md`](./executor-resolved-pendings-truncation.md) | **待实现** | 内脑 Executor 注入 resolved pending 时 `result` 被 `slice(0,600)` 截断（Gin Cookie 根因） |
| [`cross-agent-research-and-keychain.md`](./cross-agent-research-and-keychain.md) | **待实现** | 研究共享：内脑 Attributor `write_skill` 蒸馏；钥匙串落地见下项 |
| [`memory-blocks-framework.md`](./memory-blocks-framework.md) | **待实现** | Memory Block：动态分块 + 策略（`kv_secret` 钥匙串为首块）+ `memory_block_*` CRUD |

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

# Memory Belief Card（mem9 现行结论覆盖）

> **English:** Topic-keyed **current belief** cards on mem9 — supersede-on-write, not delete. Episodic ingest stays append-only; prompt prefers `belief_current`.
>
> **状态**：M1 ✅ 最小落地（upsert + DONE/EW 触发 + 读路径专段）

关联：[`MEMORY-STORAGE-BOUNDARY.md`](./MEMORY-STORAGE-BOUNDARY.md) · [`doc/todo/memory-belief-reconciliation.md`](../todo/memory-belief-reconciliation.md) · 内脑同构 [`FACTS-KNOWLEDGE-GOVERNANCE.md`](./FACTS-KNOWLEDGE-GOVERNANCE.md)

---

## 1. 问题

外脑 mem9 情节只追加：失败洞见与修好后的成功洞见同 topic 并列进上下文，模型无法区分「现行」与「曾出错」。

## 2. 解法

在 mem9 上约定 **Belief Card**（`store`/`update`，**禁止**靠 `ingest smart` 做覆盖）：

| metadata | 说明 |
|----------|------|
| `role` | `belief_current`（现行） |
| `topic` | 稳定键：`kpi:{id}` / `ew:{id}` / `credential:{key}` / `workspace:{id}` |
| `status` | `active` \| `superseded` |
| `validity` | active≈1.0；superseded≈0.2（读侧 `<0.3` 过滤） |
| `polarity` | `ok` \| `blocked` \| `unknown` |
| `prior_summary` | 可选：曾出错摘要 |
| `evidence_at` | ISO 证据时刻 |
| `source` | `inner_complete` \| `ew_settle` \| `user_repair` \| … |
| `supersedes` | 被取代的旧 mem9 id 列表 |

**同 topic 再写**：search → 旧 `belief_current` `update` 为 superseded → `store` 新现行条。  
**注入形态**：`现行：可用；注解：曾出过 BUG（已修复）`（单行结论，非两条情节并列）。

## 3. 触发

| 时机 | 动作 |
|------|------|
| 内脑 DONE / 完成报告路径 `ingestInnerOutput` | 读工作区证据 → upsert（ok/blocked） |
| EW `onSettled` | 按 `run.ok` + 产物证据 upsert |
| 用户「修好了 / 可用了 / 已修复…」 | upsert `polarity=ok` |
| 用户取消/完成（既有 MVP） | 降权 + 本地 belief 索引（不变） |

**禁止**：同伴 IM / agent 推断直接写 `belief_current`（须本地证据或用户修复意图）。

## 4. 读路径

`formatMemoryForLlm`：

1. `### 现行信念` — active `belief_current`
2. `### 已修订信念` — 本地 cancel/complete 折叠（MVP）
3. `### 最近对话日志` — episodic；**排除** `belief_current` 与 `status=superseded`

## 5. 代码入口

| 模块 | 路径 |
|------|------|
| 纯函数 + upsert 协议 | `outer/memory-belief-card.ts` |
| 门面 | `outer/outer-memory.ts`（`upsertBeliefCard` / `reconcileBeliefFromWorkspace`） |
| 接线 | `ingestInnerOutput`、EW `onSettled`、`reconcileFromUserMessage` |

## 6. 测试

- 单测：`memory-belief-card.test.ts`
- 组件：`outerMemory.component.integration.test.ts`（Fake mem9 supersede + 注入专段）

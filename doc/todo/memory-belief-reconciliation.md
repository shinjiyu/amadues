# TODO：外脑记忆跨时间降权修订（Belief Reconciliation）

> **Status:** 待实现 · **Recorded:** 2026-05-19  
> **English:** Stale mem9 / task memories keep competing with user corrections; need belief revision via downranking, not deletion.

---

## 问题

用户明确说「XX 不要做了」「这项工作已经完成了」后，外脑仍被旧记忆牵引（重复 `set_goal`、心跳继续推进等）。

根因（当前实现）：

- **mem9 `${agentSid}:chat`**：只追加（`appendChatLog`、内脑完成 `ingest`），语义检索无生命周期。
- **drive9 tasks**：仅当 LLM 调 `update_tasks` 才覆盖；用户口头纠正不保证写入。
- **mem9 `update`/`delete`** 存在但未用于用户纠正。
- **检索**：相似度排序，无 `validity` / `status` / 用户指令优先。
- **旁路**：内脑 `write_memo` → `:tasks`，外脑 `read_memory` → `:chat` 命名空间不一致。

详见讨论摘要与 [`structurizr/MEMORY-STORAGE-BOUNDARY.md`](../structurizr/MEMORY-STORAGE-BOUNDARY.md)。

---

## 目标

1. **跨时间更新** = 对旧结论 **降权**，不是硬删除（保留审计与排障）。
2. 用户 **取消 / 完成** 类表述 → 系统层 **强制对账**（不依赖模型是否调工具）。
3. 注入 LLM 的上下文默认只含 **当前有效信念**；作废项可折叠一行提示。

---

## 概念模型

### 三层

| 层 | 职责 | 写入 |
|----|------|------|
| **Episodic** | 谁在何时说了什么 | 只追加 |
| **Reconciler** | 解析取消/完成/冲突 | 规则 + 可选轻量 LLM |
| **Belief** | 当前任务板 + 带状态的结论 | 可修订、`validity` |

### 记忆元数据（mem9 或并行索引）

| 字段 | 说明 |
|------|------|
| `status` | `active` \| `completed` \| `cancelled` \| `superseded` |
| `topic_id` / `workspace_id` / `kpi_id` | 任务线关联 |
| `validity` | 0–1；取消 ≈ 0.15，完成 ≈ 0.25 |
| `superseded_by` | 指向新条 |
| `source` | `user` \| `inner_complete` \| `heartbeat` \| `agent_inference` |

### 检索（概念）

```
score = sim(query, memory) × validity × recency_decay × source_trust
```

低于阈值不进主 prompt；可选 `read_memory(include_archived=true)`。

---

## 触发对账

| 时机 | 动作 |
|------|------|
| 用户消息含取消/完成/别做了 | Mandatory reconcile → 更新 tasks + mem9 validity |
| 内脑 `DONE` | 相关 active → completed；ingest 前避免与口头冲突重复强化 |
| `set_goal` 同主题新 burst | 旧 active → superseded |
| `stop_inner_brain` / KPI abandoned | 联动降权 |
| 心跳 `read_memory` 前 | 先读 Belief 任务板，再语义补全 |

---

## 实施梯度

### MVP

- [ ] 用户取消/完成 → 规则匹配 topic → **强制** `update_tasks` 等价写入 + mem9 `validity` 降权
- [ ] `read_memory` / `readChatLog` 默认过滤 `validity < 0.3`
- [ ] 作废条在 UI/日志可折叠：`曾计划 XX（已于 T 取消）`

### M1

- [ ] 内脑 DONE、`stop_inner_brain`、KPI abandoned 与记忆状态联动
- [ ] `set_goal` 同主题 supersede
- [ ] 修复 `write_memo`（`:tasks`）与 `read_memory`（`:chat`）一致

### M2

- [ ] `reconcile_memory` 工具或心跳对账步骤
- [ ] repository K/S/P 条目 `status` / `scope=task:*`
- [ ] ADL：`workspace.dsl` + `MEMORY-STORAGE-BOUNDARY.md` 更新

---

## 待拍板

1. **降权后是否仍注入一行摘要？**（推荐 B：折叠「已取消」防重复踩坑）
2. **取消粒度**：按 `workspace_id` / `kpi_id` 整包降权，还是仅匹配到的 mem9 条？

---

## 参考

- `packages/server/src/outer/outer-memory.ts`
- `packages/server/src/mem9/mem9-client.ts`（`update` / `delete`）
- `packages/server/src/outer/outer-tools.ts`（`update_tasks`、`read_memory`）

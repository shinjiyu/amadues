# drive9 共享事实（完全共享模型）

> **English:** `/knowledge/shared/` is the **single** cross-agent, cross-burst fact pool. **Write** on `record_fact` (sync). **Read** on `set_goal` seed into `memory.json`. No burst-exit promotion, no `knowledge.md` shuttle.

关联：[`MEMORY-STORAGE-BOUNDARY.md`](./MEMORY-STORAGE-BOUNDARY.md) · [`FACTS-KNOWLEDGE-GOVERNANCE.md`](./FACTS-KNOWLEDGE-GOVERNANCE.md) · [`DYFLOW-INNER-EXECUTOR.md`](./DYFLOW-INNER-EXECUTOR.md) §11

---

## 1. 原则

| 层 | 角色 |
|----|------|
| **drive9 `/knowledge/shared/`** | 跨 agent / 跨 burst **唯一共享事实池**（与 `/skills/shared/`、`/nodes/shared/` 对称） |
| **workspace `memory.json`** | 本 burst **工作集**（`fact_records` + prompt 投影 `facts[]`） |
| ~~burst 结束晋升~~ | **退役** — 不再从 workspace 批量推到 drive9 |
| ~~`knowledge.md` seed~~ | **退役** — DyFlow 不读该文件 |

---

## 2. 写路径

```text
record_fact / Attributor
  → memoryStore.recordFact → .brain/memory.json
  →（drive9 已配置）sharedFactSink → KnowledgeDrive9Store.storeShared
```

- **时机**：事实写入 memory 后 **立即** fire-and-forget，不等 burst onExit
- **过滤**：脱敏 / 截断 / `shouldSkipFactPromotion`（`knowledge-promote.ts`）
- **id**：`FactRecord.id` 与 drive9 文件 `kn-{hash}.md` 对齐

模块：`outer/knowledge-promote.ts` `createDrive9FactSyncSink` · `pi-mono/run-tick.ts` 注入 `sharedFactSink`

---

## 3. 读路径

```text
set_goal → seedInnerBrainSharedContext
  → KnowledgeDrive9Store.searchShared(goal)
  → seedDrive9FactsToMemory → memory.json fact_records（source.via=seed）
  → Designer / baseNode read_memory
```

- 按 goal grep 检索，**不**写 `knowledge.md`
- 已存在同 topic/id 的事实由 `recordFactGoverned` 去重 / supersede

模块：`outer/knowledge-promote.ts` `seedDrive9FactsToMemory` · `outer/agent-pool.ts`

---

## 4. 退役

| 退役 | 替代 |
|------|------|
| `mergeWorkDirKnowledgeToDrive9` | `createDrive9FactSyncSink` |
| `mergeMemoryFactsToDrive9` / `promoteWorkDirFactsToDrive9` | 同上（onExit 不再调用） |
| `seedRelevantKnowledgeToWorkDir` → `knowledge.md` | `seedDrive9FactsToMemory` |

---

## 5. 测试

| 模块 | 单测 |
|------|------|
| seedDrive9FactsToMemory | `knowledge-promote.test.ts` |
| createDrive9FactSyncSink | `knowledge-promote.test.ts` |
| memory onFactRecorded → sink | `memory-store.test.ts` |

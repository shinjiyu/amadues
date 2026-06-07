# 事实知识治理（Facts / Knowledge Governance）

> **English:** Prevent `memory.facts` and drive9 `/knowledge/shared/` from accumulating stale, duplicate, and contradictory prose. Combine **merge (supersede)** on write with **eviction (quota / cold / retract)** on sweep — mirroring `nodeDefEviction` for NodeDef.

> **状态**：设计定稿（2026-06-07）· **实现**：P0 → P2 分阶段

关联：[`DYFLOW-INNER-EXECUTOR.md`](./DYFLOW-INNER-EXECUTOR.md) §7b · [`DYFLOW-ATTRIBUTION.md`](./DYFLOW-ATTRIBUTION.md) · [`MEMORY-STORAGE-BOUNDARY.md`](./MEMORY-STORAGE-BOUNDARY.md) · [`INNER-NODE-LIFECYCLE.md`](./INNER-NODE-LIFECYCLE.md) §7（NodeDef eviction 范式）

---

## 1. 问题（bot2 实证）

| 现象 | 根因 |
|------|------|
| 同一文件路径 / API 端点重复记 5～10 条 | `appendFact` 仅 **全文精确去重** |
| 「章节序号用 `.serial-input`」vs「无法定位序号框」并存 | 无 **topic 合并 / 取代** |
| `chapter_list` 3 章已发 vs ch4–6 已写完 | 无 **时效 / 置信度 / 作废** |
| Designer/baseNode prompt 灌入全部 facts | 无 **注入上限 + 按分排序** |
| drive9 晋升按 content hash 去重，但不淘汰 | 无 **cold / quota sweep** |

当前存储：

| 层 | 路径 | 写入 | 治理 |
|----|------|------|------|
| **workspace memory** | `.brain/memory.json` → `facts: string[]` | `record_fact` / Attributor | ❌ 仅 `includes` 去重 |
| **drive9 共享** | `/knowledge/shared/{kn-hash}.md` | `record_fact` → `createDrive9FactSyncSink`（实时，见 [`DRIVE9-KNOWLEDGE-SHARED.md`](./DRIVE9-KNOWLEDGE-SHARED.md)） | ❌ 无 eviction |
| **constraints** | `memory.constraints[]` | `record_constraint` / failure-distill | 同 facts，但更短；可共用治理框架 |

---

## 2. 设计目标

1. **合并**：同一 **topic** 新事实 **取代** 旧事实，不并列堆积。
2. **淘汰**：超配额、长期未引用、显式作废 → `superseded` / `retracted`，不进 prompt。
3. **矛盾可见**：同 topic 冲突 → 标记 `needs_reconcile`，交给 Attributor 一轮收敛。
4. **可审计**：淘汰不物理删除（archive 区），可追溯谁取代谁。
5. **双层一致**：workspace `memory.facts` 与 drive9 shared 用同一 `FactRecord` schema。

---

## 3. FactRecord schema（替代裸 `string[]`）

```text
FactRecord {
  id:           string          # kn-{contentHash12} 或 fact-{ulid}
  topic:        string          # 归一化主题键，合并主键（见 §4）
  content:      string          # 人类可读陈述（可保留 [事实] 前缀）
  status:       active | superseded | retracted
  confidence:   verified | hypothesis | obsolete   # 默认 hypothesis
  source: {
    burstId?:    string
    nodeInstId?: string
    at:          ISO8601
    via?:        record_fact | attributor | seed | promote
  }
  supersedes?:  string          # 被本条取代的 fact id
  citeCount:    number           # 被 Designer/baseNode/检索命中次数（P1）
  lastCitedAt?: ISO8601
  tags:         string[]         # fanqie, api, selector, playbook, …
}
```

**memory.json 形态**（兼容迁移）：

```json
{
  "facts": ["legacy string …"],
  "fact_records": [ { "id": "kn-abc", "topic": "fanqie.publish.ui", … } ]
}
```

读取时：`fact_records` 优先；`facts[]` 字符串在首次 `read()` 时 **惰性迁移** 为 `FactRecord`（topic 启发式提取，见 §4.3）。

---

## 4. 合并（Merge）

### 4.1 Topic 归一化

合并主键 `topic`，不是全文 hash。规则（机械，P0）：

| 输入模式 | topic 示例 |
|----------|------------|
| 含 `publish_context.json` + 结构 | `ctx.publish_context` |
| 含 `fanqie` + `API` / `/api/author/` | `fanqie.api.{endpoint_slug}` |
| 含 `fanqie` + `UI` / `编辑器` / `selector` | `fanqie.ui.editor` |
| 含 `playbook` / `.playbook.json` | `playbook.{basename}` |
| 含 `workspace/ch{N}.txt` | `artifact.ch{N}` |
| 默认 | `general.{contentHash8}` |

实现：`fact-topic.ts` → `deriveFactTopic(content): string`

### 4.2 写入时取代（supersede-on-write）

`record_fact` / Attributor 写入流程：

```text
1. 解析 content → topic（可选手动 topic= 参数覆盖）
2. 查 active 记录 where topic 相同
3. 若存在：
     - 旧记录 status → superseded，写 supersedes 链
     - 新记录 status → active
4. 若 content hash 与某 active 完全相同 → 仅 bump citeCount + lastCitedAt（不新增）
5. 否则 append 新 FactRecord
```

**禁止**并列两条同 topic 的 `active` 记录。

### 4.3 归因后合并（P2 · LLM）

ATTRIBUTE 结束增加可选一步 `reconcileFacts`（Attributor 子任务或独立 sweep）：

- 输入：同 topic 多条 active、或 `needs_reconcile` 标记对
- 输出：一条 `verified` 合并陈述 + 其余 `superseded`
- 仅在 heuristic 发现矛盾时触发（§5.3），非常开 LLM

---

## 5. 淘汰（Eviction）

对齐 `nodeDefEviction` 两阶段：**cold** + **quota**。

### 5.1 分数函数

```text
score(f) =
    w_cite   * citeCount
  + w_conf   * (verified=3, hypothesis=1, obsolete=0)
  + w_recency * recencyDays⁻¹
  - w_age    * ageDays
  - w_contra * contradictionFlags
```

默认权重：`cite=2, conf=1, recency=1, age=0.05, contra=5`（与 NodeDef 同量级可调）

### 5.2 规则

| 规则 | 条件 | 动作 |
|------|------|------|
| **quota** | `active` 数 > `INNER_FACTS_MAX_ACTIVE`（默认 60） | 按 score 升序 `superseded`，直到 ≤ max×(1−headroom) |
| **cold** | `citeCount=0` 且 `ageDays > INNER_FACTS_COLD_DAYS`（默认 14）且 `confidence≠verified` | `superseded` reason=cold |
| **retract** | Attributor / 外脑显式 `retract_fact` | `retracted`（红线性错误知识） |
| **obsolete** | 新 fact 写入同 topic 时 | 旧 fact 自动 supersede（§4.2，非 eviction 扫） |

### 5.3 矛盾启发式（P1 · 无 LLM）

同 topic 仅应 1 条 active；若迁移期出现多条：

- 标记 `needs_reconcile=true`
- ATTRIBUTE 后优先进入 `reconcileFacts`（P2）

跨 topic 矛盾（难）：

- 关键词对：`已发布` vs `草稿` + 同一 `ch4` → flag
- `不可用` vs `有效` + 同一 selector → flag  
→ 写入 `memory.fact_conflicts[]` 供 Dashboard / Attributor

### 5.4 执行时机

| 时机 | 模块 | 动作 |
|------|------|------|
| 每次 `record_fact` | `fact-governor.ts` | supersede-on-write + hash dedupe |
| ATTRIBUTE 结束后 | `fact-governor.ts` | quota + cold sweep |
| 外脑心跳（可选 P2） | `outer/fact-drive9-eviction.ts` | drive9 `/knowledge/shared/` 同步规则 |
| drive9 实时同步 | `knowledge-promote.ts` `createDrive9FactSyncSink` | `record_fact` 后 fire-and-forget `storeShared` |
| set_goal seed | `seedDrive9FactsToMemory` | drive9 grep → `memory.fact_records`（`via: seed`） |

---

## 6. Prompt 注入治理

**问题**：baseNode / Designer 现把 **全部** `memory.facts` 列入 prompt（bot2 曾 60+ 条）。

| 规则 | 行为 |
|------|------|
| **R1** | 只注入 `status=active` |
| **R2** | 上限 `INNER_FACTS_PROMPT_MAX`（默认 24 条） |
| **R3** | 排序：`verified` > score > `lastCitedAt` |
| **R4** | 超出部分提示：「另有 N 条事实已省略；用 read_memory key=fact_records 或 search_facts」 |
| **R5** | `constraints` 可共用上限（默认 16） |

实现：`selectFactsForPrompt(records, opts)` in `fact-governor.ts`；`base-node-executor` / `designer.ts` 改用之。

---

## 7. 工具契约（演进）

| 工具 | P0 | 说明 |
|------|-----|------|
| `record_fact` | 扩展 | 可选 `topic?`, `confidence?`, `tags?`；内置 supersede |
| `retract_fact` | 新增 | Attributor / 外脑：显式作废 `id` 或 `topic` |
| `supersede_fact` | 可选 | 手动指定 `old_id` + `new_content` |
| `read_memory` | 已有 | 支持 `key=fact_records` 全量审计 |

**禁止**：baseNode 为绕过治理写超长 fact 拆成多条；应用 `browser_run_steps` playbook 或单条 topic。

---

## 8. drive9 层对齐（完全共享）

专篇：[`DRIVE9-KNOWLEDGE-SHARED.md`](./DRIVE9-KNOWLEDGE-SHARED.md)

| 项 | 路径 |
|----|------|
| **写** | `record_fact` → `createDrive9FactSyncSink` → `/knowledge/shared/` |
| **读** | `seedDrive9FactsToMemory` ← `searchShared(goal)` |
| **退役** | burst onExit 晋升、`knowledge.md` seed |
| id | `kn-{contentHash}` + `topic` meta |
| 淘汰（P2） | tombstone → `/knowledge/archive/` |

---

## 9. ADL 组件

| 模块 ID | 路径 | 职责 |
|---------|------|------|
| **factTopic** | `inner-brain/fact-topic.ts` | topic 归一化 |
| **factGovernor** | `inner-brain/fact-governor.ts` | supersede / score / sweep / prompt select |
| **memoryStore** | `inner-brain/memory-store.ts` | `fact_records` CRUD + 惰性迁移 |
| **factDrive9Eviction** | `outer/fact-drive9-eviction.ts` | drive9 共享事实淘汰（P2） |

---

## 10. 实施顺序（Structurizr-first）

| 阶段 | 内容 | 测项 |
|------|------|------|
| **P0** | `FactRecord` + `deriveFactTopic` + supersede-on-write + `INNER_FACTS_MAX_ACTIVE` + prompt 上限 | `fact-topic.test.ts`, `fact-governor.test.ts`, `memory-store` 迁移 |
| **P1** | ATTRIBUTE 后 cold+quota sweep；`citeCount` 计数；矛盾启发式 flag | `fact-governor.component.integration.test.ts` |
| **P2** | Attributor `reconcileFacts`；drive9 eviction；`retract_fact` 工具 | `fact-drive9-eviction.test.ts` |

---

## 11. 与 constraints 的关系

- **constraints** = 红线 / 避坑（「不要做 X」）
- **facts** = 环境真相（「世界是 Y」）

治理框架可共用 `GovernedRecord` 基类，但 **分表存储**：

- facts 走 topic supersede + 晋升 drive9
- constraints 走 **合并相似前缀**（`[run-failure]` 同类保留最近 3 条）+ 上限 40

failure-distill 写入的模板 constraint 参与 **constraint 专用** quota，不混入 facts。

---

## 12. 修订

| 日期 | 说明 |
|------|------|
| 2026-06-07 | 初版：merge + eviction + prompt 上限；对齐 nodeDefEviction |

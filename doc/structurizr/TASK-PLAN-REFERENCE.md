# 任务方案参考检索（Designer `search_task_plans`）

> **English:** Before committing `local_dag`, Designer may **on demand** search prior burst plans / playbooks. Hits are **reference only** — never promoted to `memory.fact_records` or drive9 shared facts.

> **状态**：设计定稿（2026-06-07）· **实现**：P0

关联：[`DYFLOW-INNER-EXECUTOR.md`](./DYFLOW-INNER-EXECUTOR.md) §9 · [`MEMORY-STORAGE-BOUNDARY.md`](./MEMORY-STORAGE-BOUNDARY.md) · [`KPI-BURST-OUTCOME-EVALUATOR.md`](./KPI-BURST-OUTCOME-EVALUATOR.md)

---

## 1. 动机

| 需求 | 为何不由外脑 `set_goal` 预搜 |
|------|------------------------------|
| Designer 按局面决定搜什么 | 外脑派工时还不知道要查 API 死路还是章节编排 |
| 搜索时机在「编排前」 | 对内脑即 **DESIGN tick**，`commit_local_dag` 之前 |
| 结果不能污染 facts | 检索命中是假设/历史尝试，须与 `record_fact` 分流 |

外脑对话检索（`knowledge-retrieval`）服务 IM，**不是**内脑编排工具。

---

## 2. 落点

```text
Designer LLM
  → search_task_plans(query, sources?)
       → PlanReferencePort（外脑实现，run-tick 注入）
            ├─ archiveStore.retrieve + buildContext
            ├─ repository execution lane
            └─ peer workspace goal / last_failure 摘要
  → 写入 memory.plan_references[]（可选暂存，非 facts）
  → commit_local_dag
```

| 层 | 模块 | 文件 |
|----|------|------|
| 契约 | `PlanReferencePort` | `openkuroneko/inner-brain/plan-reference-port.ts` |
| Designer 工具 | `search_task_plans` | `openkuroneko/inner-brain/designer-tools.ts` |
| 检索实现 | `createPlanReferencePort` | `outer/plan-reference-search.ts` |
| 装配 | run-tick 注入 | `pi-mono/run-tick.ts` |

内脑 **不** `import FilesystemRepositoryStore`；与 `search_and_instance` → `nodeDefDrive9Store` 同模式。

---

## 3. 存储边界

| 键 / 路径 | 语义 | 写入方 | 进 facts？ |
|-----------|------|--------|-----------|
| `memory.plan_references[]` | 本轮 DESIGN 暂存的参考片段 | `search_task_plans` | **否** |
| `memory.fact_records` | 已验证环境事实 | `record_fact` / Attributor | 是 |
| drive9 `/knowledge/shared/` | 跨 burst 共享事实 | `sharedFactSink` | 是 |

规则：

1. `search_task_plans` **禁止**调 `recordFact` / `sharedFactSink`
2. `selectFactsForPrompt` **不读** `plan_references`
3. Attributor 仅读 `fact_records` 预览，不蒸馏 `plan_references`
4. burst 结束可清空 `plan_references`（P1）；P0 覆盖写即可

---

## 4. `search_task_plans` 契约

```typescript
search_task_plans({
  query: string;                              // Designer 自拟
  sources?: ('archive' | 'repository' | 'peer')[];
  topK?: number;                             // 默认 5
})
```

- `kpiId` 从 `INNER_KPI_ID` 注入 Port，工具参数不暴露
- 返回 Markdown，标题含 `【参考·未验证】`
- 同时 append 到 `memory.plan_references`（上限 20 条）

**Designer 宜调用时机**：目标陌生、连续 `last_failure`、换向编排前；不必每 tick 盲搜。

---

## 5. 数据源

| source | 后端 | 内容 |
|--------|------|------|
| `archive` | `createFilesystemStore(UTLRA_ARCHIVE_DIR \|\| DATA_ROOT/knowledge-archive)` | 同 KPI 历次 burst 约束/技能/知识与 `burstOutcome` |
| `repository` | `FilesystemRepositoryStore(DATA_ROOT)` execution lane | 晋升 K/S/P playbook |
| `peer` | `INNER_WORKSPACES_ROOT` + `INNER_PEER_WORKSPACE_IDS` | 同 KPI sibling 的 `goal.md` / `memory.json` last_failure |

---

## 6. 测试

| 层级 | 文件 | 状态 |
|------|------|------|
| unit | `outer/plan-reference-search.test.ts` | ✅ |
| unit | `inner-brain/search-task-plans.test.ts` | ✅ |
| component | `planReferenceSearch.component.integration.test.ts` | ⏳ |

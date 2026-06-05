# KPI 闭环（ADL 与实现对齐）

> 与 `workspace.dsl` 视图 `10-L2-KPI-Closed-Loop`、`10b-L3-Outer-KPI`、`10c-L3-Inner-Reflexion` 同步。

## 两条链路（勿混）

| 链路 | 触发 | 产出 | 消费者 |
|------|------|------|--------|
| **Per-burst reflexion** | 内脑 `safeArchive`（COMPLETE/BLOCK/REPLAN_LIMIT/CYCLE_MAX） | `.brain/reflexion.json` + archive session | `kpiBurstHooks` → `reflexionTrail`；下轮 `decomposer(kpiId)` |
| **Meta reflexion burst** | `idleStreak ≥ 阈值` | 短 burst + 同上 reflexion | `UTLRA_KPI_AUTO_NEXT_BURST=1` 时可 `scheduleNextKpiBurst` |

## 闭环步骤（实现顺序）

```text
1. 外脑 set_kpi                    → kpiRegistry
2. 外脑 set_goal(kpi_id)           → 首次创建 canonical instance；后续 **复用同一 instance/workDir** 续跑
3. 子进程 INNER_KPI_ID             → controller.kpiId
4. burst 结束 safeArchive          → runReflexion → reflexion.json → archive(kpiId, reflexion)
5. 外脑 onExit processBurstExitForKpi → appendReflexion + idle streak
6. streak≥3                        → scheduleReflexionBurst (meta)
7. meta onExit + AUTO_NEXT_BURST   → scheduleNextKpiBurst (真任务)
8. 下一轮 decomposer               → knowledgeStore.retrieve(goal, { kpiId })
9. 心跳 kpiCompletionJudge.sweep   → active 且条件满足 → achieved（见 KPI-COMPLETION-JUDGE.md）
```

## 数据文件

| 路径 | 角色 |
|------|------|
| `data/kpi-registry.json` | KPI 元数据、bursts[]（canonical id 列表，续跑不追加新 id）、reflexionTrail[]、idleStreak |
| `<workDir>/.brain/reflexion.json` | 单次 burst 结构化反思（onExit 读取） |
| `~/.openkuroneko/knowledge-base/sessions/` | 带 kpiId + reflexion 的归档 |

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `UTLRA_KPI_STUCK_THRESHOLD` | `3` | 触发 meta reflexion burst |
| `UTLRA_KPI_REFLEXION_MAX_TICKS` | `20` | meta burst max_ticks |
| `UTLRA_KPI_AUTO_NEXT_BURST` | `0` | `1` = meta 结束后自动派真任务；真任务 **无 deliverable** 退出时可模板续跑（**不 resetIdle**，累加至阈值触发 meta；有产出则不续跑） |
| `UTLRA_REFLEXION_TEMPERATURE` | `0.4` | runReflexion LLM 温度 |

单实例复用详见 [`INNER-BRAIN-SINGLE-INSTANCE.md`](./INNER-BRAIN-SINGLE-INSTANCE.md)。

## KPI 规划上下文边界（勿串扰）

| 来源 | 进入 KPI goal 规划？ | 说明 |
|------|---------------------|------|
| `kpi.bursts[]` 且 `TaskRecord.kpiId` 一致 | ✅ | `buildKpiBurstLinks` / burst 详情 |
| 同 `kpi_id` 的 RUNNING/AWAITING/BLOCKED | ✅ | `formatLiveBurstSummary(registry, kpiId)` |
| 无 `kpi_id` 的一次性 `set_goal` | ❌ | 仅 `mem9` / `update_tasks` |
| 其它 active KPI 摘要 | 仅标题行 | 防重复主题，不展开 burst |
| 群聊 / 他 agent 线程 | ❌ | 记忆检索，不进 `kpi-registry` |

`suggestKpiAction` 的 `follow_up` / `async_waiting` 只统计**在途** burst（`LIVE_KPI_BURST_STATUSES`），避免历史 `DONE` 行仍标 `AWAITING` 误阻断 `UTLRA_KPI_AUTO_NEXT_BURST` 续跑。

实现：`kpi-goal-context.ts`、`kpi-progress.ts`。

## Ops API：`POST /api/kpis/:id/dispatch`

| 字段 | 说明 |
|------|------|
| 用途 | E2E / Dashboard 直连 `set_goal(kpi_id)`，不经过外脑 LLM |
| body | `{ goal?, origin_thread?, origin_user? }`；`goal` 缺省用 KPI `description` |
| 门禁 | 同 `evaluateKpiAutonomyDispatch`（在途 burst / stuck reflexion 等拒绝） |
| 实现 | `outer/kpi-api-dispatch.ts` |

## 外脑心跳在闭环中的角色

心跳（[`OUTER-HEARTBEAT-OVERSIGHT.md`](./OUTER-HEARTBEAT-OVERSIGHT.md)）消费本闭环的 **reflexionTrail / idleStreak / deliverables**，负责：

- **宏观战略**（[`STRATEGY-PLANNING-LAYER.md`](./STRATEGY-PLANNING-LAYER.md)）：**WHY** 还推哪些 KPI + **HOW** focusOrder/下一角度——**不受质控层替代**；
- **质控**：burst 是否在向 KPI 实质靠近（非 milestone 级 Attributor 验收）；
- **KPI 完成判定**：[`KPI-COMPLETION-JUDGE.md`](./KPI-COMPLETION-JUDGE.md) — sweep + achieve_kpi；
- **干预**：idle streak → meta reflexion；真 stuck → reap/restart（部分 ⏳ 见专篇 §4）。

勿与 **Attributor CONTINUE**（单 tick 增量靠近）混淆：内脑可以慢，外脑用 streak + liveness 判断「慢但有效」vs「卡死」。

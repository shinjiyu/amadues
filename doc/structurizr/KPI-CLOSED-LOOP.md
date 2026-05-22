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
2. 外脑 set_goal(kpi_id)           → 注入 formatKpiReflexionBlock + innerBrainRegistry + innerSpawner
3. 子进程 INNER_KPI_ID             → controller.kpiId
4. burst 结束 safeArchive          → runReflexion → reflexion.json → archive(kpiId, reflexion)
5. 外脑 onExit processBurstExitForKpi → appendReflexion + idle streak
6. streak≥3                        → scheduleReflexionBurst (meta)
7. meta onExit + AUTO_NEXT_BURST   → scheduleNextKpiBurst (真任务)
8. 下一轮 decomposer               → knowledgeStore.retrieve(goal, { kpiId })
```

## 数据文件

| 路径 | 角色 |
|------|------|
| `data/kpi-registry.json` | KPI 元数据、bursts[]、reflexionTrail[]、idleStreak |
| `<workDir>/.brain/reflexion.json` | 单次 burst 结构化反思（onExit 读取） |
| `~/.openkuroneko/knowledge-base/sessions/` | 带 kpiId + reflexion 的归档 |

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `UTLRA_KPI_STUCK_THRESHOLD` | `3` | 触发 meta reflexion burst |
| `UTLRA_KPI_REFLEXION_MAX_TICKS` | `20` | meta burst max_ticks |
| `UTLRA_KPI_AUTO_NEXT_BURST` | `0` | `1` = meta 结束后自动派真任务 |
| `UTLRA_REFLEXION_TEMPERATURE` | `0.4` | runReflexion LLM 温度 |

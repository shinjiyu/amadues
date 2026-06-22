# KPI 闭环（ADL 与实现对齐）

> 与 `workspace.dsl` 视图 `10-L2-KPI-Closed-Loop`、`10b-L3-Outer-KPI` 同步。  
> **外脑派遣主路径**（2026-06-07 起）见 [`KPI-ADVANCEMENT.md`](./KPI-ADVANCEMENT.md)：`kpiAdvancer` 遍历 leaf KPI + burst 复用。  
> **burst 结果反馈**（2026-06-07 起）见 [`KPI-BURST-OUTCOME-EVALUATOR.md`](./KPI-BURST-OUTCOME-EVALUATOR.md)（取代 per-burst `reflexion.json` / `scheduleReflexionBurst`）。

## 两条链路（勿混）

| 链路 | 触发 | 产出 | 消费者 |
|------|------|------|--------|
| **KPI burst 结果评估** | 外脑 `processBurstExitForKpi`（有 `kpi_id`） | `burstRunHistory.outcomeEvaluation` + 可选 `scheduleNextKpiBurst` | `kpiAdvancer` charter、`strategyPlanner`、`view_kpi` |
| **Ad-hoc 完成** | 无 `kpi_id` burst DONE | `completionNotify` → IM；`ingestInnerOutput` → mem9 | 用户 |

> **IM 通知 ≠ KPI 评估**：KPI burst **不**走 `completionNotify`（见 [`KPI-BURST-OUTCOME-EVALUATOR.md`](./KPI-BURST-OUTCOME-EVALUATOR.md) §1）。用户可见 ad-hoc 通知走 [`INNER-BRAIN-IM-NOTIFY-BOUNDARY.md`](./INNER-BRAIN-IM-NOTIFY-BOUNDARY.md)。

| **idle 换向续跑** | `outcomeEvaluator` 失败 + `suggestedRetryCharter` | 更新 `kpi.charter` + `scheduleNextKpiBurst` | 同 canonical instance 续跑 |

## 闭环步骤（实现顺序）

```text
1. 外脑 set_kpi / IM 路由              → kpiRegistry
2. kpiAdvancer / advance_kpi           → set_goal(kpi_id) 复用 canonical instance
3. 子进程 INNER_KPI_ID                 → DyFlow controller
4. burst onExit processBurstExitForKpi → outcomeEvaluator → burstRunHistory
5. 失败且可重试                        → suggestedRetryCharter + scheduleNextKpiBurst
6. successConfirmed + delivery KPI     → 可选 markAchieved
7. 心跳 strategyPlanner + kpiAdvancer  → 下一 leaf sprint
8. kpiCompletionJudge.sweep            → achieved（见 KPI-COMPLETION-JUDGE.md）
```

## 数据文件

| 路径 | 角色 |
|------|------|
| `data/kpi-registry.json` | KPI 元数据、`bursts[]`、`burstRunHistory[]`、`consecutiveIdleBursts`、`momentum` |
| `<workDir>/.brain/memory.json` | DyFlow 工作集（`fact_records`）；跨 burst 共享见 [`DRIVE9-KNOWLEDGE-SHARED.md`](./DRIVE9-KNOWLEDGE-SHARED.md) |
| ~~`reflexionTrail` / `reflexion.json`~~ | **已删除**（加载时 strip） |

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `UTLRA_KPI_STUCK_THRESHOLD` | `3` | outcome 评估 idle 达阈值时用 **pivot charter** 换向（非 meta reflexion） |
| `UTLRA_KPI_AUTO_NEXT_BURST` | `0` | `1` = 评估失败且 `suggestedRetryCharter` 时自动 `scheduleNextKpiBurst` |

单实例复用详见 [`INNER-BRAIN-SINGLE-INSTANCE.md`](./INNER-BRAIN-SINGLE-INSTANCE.md)。

## KPI 规划上下文边界（勿串扰）

| 来源 | 进入 KPI goal 规划？ | 说明 |
|------|---------------------|------|
| `kpi.burstRunHistory` | ✅ | `formatBurstRunDigest` / outcome |
| `kpi.bursts[]` 且 `TaskRecord.kpiId` 一致 | ✅ | `buildKpiBurstLinks` |
| 无 `kpi_id` 的一次性 `set_goal` | ❌ | ad-hoc；completionNotify |
| 群聊 / 他 agent 线程 | ❌ | mem9 检索 |

实现：`kpi-goal-context.ts`、`kpi-progress.ts`、`inner-brain-kpi-reuse.ts`。

## Ops API

| 路由 | 说明 |
|------|------|
| `POST /api/kpis/:id/dispatch` | E2E 直连 `kpiAdvancer` / `set_goal(kpi_id)` |
| `POST /api/kpis/:id/reflect` | **410 已退役**；用 dispatch / `advance_kpi` |

## 外脑心跳在闭环中的角色

心跳（[`OUTER-HEARTBEAT-OVERSIGHT.md`](./OUTER-HEARTBEAT-OVERSIGHT.md)）消费 **burstRunHistory / idleStreak / deliverables / momentum**：

- **宏观战略**（[`STRATEGY-PLANNING-LAYER.md`](./STRATEGY-PLANNING-LAYER.md)）：WHY + HOW focusOrder；
- **质控**：在途 burst 是否向 KPI 靠近；
- **KPI 完成判定**：[`KPI-COMPLETION-JUDGE.md`](./KPI-COMPLETION-JUDGE.md)；
- **干预**：idle → outcome 换向续跑；真 stuck → `staleBurstReaper`（⏳）。

勿与 **Attributor**（单 RUN 归因写 `memory.facts`）混淆。

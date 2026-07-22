# KPI 闭环（ADL · 数字员工对齐）

> 与 `workspace.dsl` 视图 `10-L2-KPI-Closed-Loop`、`10b-L3-Outer-KPI`、`14-L3-Digital-Employee-Loop` 同步。
> **现行权威**：[`DIGITAL-EMPLOYEE-AUTONOMY.md`](./DIGITAL-EMPLOYEE-AUTONOMY.md)（容量驱动主循环）+ [`KPI-MANAGER-LAYER.md`](./KPI-MANAGER-LAYER.md)（KPI 治理）。
> [`KPI-ADVANCEMENT.md`](./KPI-ADVANCEMENT.md) / [`STRATEGY-PLANNING-LAYER.md`](./STRATEGY-PLANNING-LAYER.md) 仅历史对照。

## 两条链路（勿混）

| 链路 | 触发 | 产出 | 消费者 |
|------|------|------|--------|
| **KPI burst 结果反馈** | burst exit（有 `kpi_id`） | `burstRunHistory` / momentum / action-log | `SelfWorkPolicy` 输入、`kpiManager` R7、`view_kpi` |
| **Ad-hoc 完成** | 无 `kpi_id` burst DONE | `completionNotify` → IM；`ingestInnerOutput` → mem9 | 用户 |

> **IM 通知 ≠ KPI 评估**：KPI burst **不**走 `completionNotify`（见 [`KPI-BURST-OUTCOME-EVALUATOR.md`](./KPI-BURST-OUTCOME-EVALUATOR.md) §1）。用户可见 ad-hoc 通知走 [`INNER-BRAIN-IM-NOTIFY-BOUNDARY.md`](./INNER-BRAIN-IM-NOTIFY-BOUNDARY.md)。

| **容量释放后找活** | `burst_finished` / `calendar_due` / dependency resolved | `digitalEmployeeLoop` → Calendar 优先或 SelfWorkPolicy 提案 | 唯一 `set_goal` |

## 闭环步骤（实现顺序）

```text
1. 外脑 set_kpi / IM 路由                 → kpiRegistry（长期职责）
2. digitalEmployeeLoop / Ops advance      → 唯一 set_goal（新 workspace **burst**）
3. 子进程 INNER_KPI_ID                    → DyFlow controller
4. burst exit                             → 状态落盘 + burstRunHistory/momentum 反馈
5. 发出 burst_finished（禁止 onExit 直接 spawn）
6. digitalEmployeeLoop                    → capacity → due Calendar / SelfWorkPolicy → set_goal
7. delivery KPI 达成                      → kpiCompletionJudge.sweep / achieve_kpi
8. heartbeat watchdog                     → 监督 + missed + heartbeat_fallback（非主时钟）
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
| `UTLRA_KPI_STUCK_THRESHOLD` | `3` | 无进展 streak 阈值；供 SelfWorkPolicy / R7 路线熔断参考 |
| `UTLRA_KPI_AUTO_NEXT_BURST` | — | **已废弃**；`scheduleNextKpiBurst` 已删。续派走 `digitalEmployeeLoop` |

单实例复用详见历史 [`INNER-BRAIN-SINGLE-INSTANCE.md`](./INNER-BRAIN-SINGLE-INSTANCE.md)（已废弃）。

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

心跳（[`OUTER-HEARTBEAT-OVERSIGHT.md`](./OUTER-HEARTBEAT-OVERSIGHT.md)）是 **watchdog**，不是主发动机：

- **容量驱动续派**（[`DIGITAL-EMPLOYEE-AUTONOMY.md`](./DIGITAL-EMPLOYEE-AUTONOMY.md)）：burst/calendar/dependency 事件 → `digitalEmployeeLoop`；
- **质控**：在途 burst 是否向 KPI 靠近、卡死/失约；
- **KPI 完成判定**：[`KPI-COMPLETION-JUDGE.md`](./KPI-COMPLETION-JUDGE.md)；
- **干预**：R3–R7 / stale reap；漏事件时 `heartbeat_fallback`。

勿与 **Attributor**（单 RUN 归因写 `memory.facts`）混淆。

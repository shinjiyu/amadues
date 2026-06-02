# KPI 完成判定（ADL）

> **English:** Heartbeat and strategy layers **must judge whether each active KPI is complete**—not only whether bursts are stuck. Programmatic sweep (`kpiCompletionJudge`) + LLM tools (`view_kpi` / `achieve_kpi`) + burst onExit auto-achieve form one pipeline.

与 [`KPI-CLOSED-LOOP.md`](./KPI-CLOSED-LOOP.md)、[`OUTER-HEARTBEAT-OVERSIGHT.md`](./OUTER-HEARTBEAT-OVERSIGHT.md)、[`STRATEGY-PLANNING-LAYER.md`](./STRATEGY-PLANNING-LAYER.md) 互补。

---

## 1. 动机

- **burst 级** `is_post_complete` ≠ **KPI 级** `achieved`：监督类、多 burst 探索类 KPI 可能长期 active。
- `kpiBurstHooks` 在 onExit 已尝试 `autoAchieved`，但进程异常、对账滞后时 registry 仍可能 **active + suggestKpiAction=achieved**。
- 心跳 / 战略 WHY 须问：**这个 KPI 的目标是否已经达成？** 而非只问「内脑是否在跑」。

---

## 2. 判定分层

| 层 | 谁判 | 依据 | 产出 |
|----|------|------|------|
| **程序化** | `kpiCompletionJudge.sweep` | `suggestKpiAction` + 无在途 burst + DONE/post_complete/deliverables/reflexion | 自动 `markAchieved` |
| **心跳 LLM** | legacy `runHeartbeat` | `list_kpis` / `view_kpi` digest；语义上目标已到手 | `achieve_kpi(evidence)` |
| **战略 WHY** | `strategyPlanner`（P1） | reflexionTrail + 长期目标；开放式 KPI 是否该结案 | `pausedKpis` 或 dispatch 前 achieve |
| **用户** | IM / 外脑对话 | 用户明确「完成了」 | `achieve_kpi` 或 belief reconcile |

**勿混**：里程碑全完成 → 内脑 `is_post_complete`；KPI 达成 → registry `status=achieved`（可能需多 burst 或战略判断）。

---

## 3. `suggestKpiAction → achieved` 条件（与代码一致）

active KPI 且**无** RUNNING/AWAITING/BLOCKED 在途 burst 时，最近 burst 满足：

- `registryStatus === DONE` 且 `isPostComplete === true`
- `deliverableCount >= 1`
- `lastReflexionVerdict` 为 `success` | `partial` | `null`

监督类 / 未 post_complete → **不** achieved，继续 `follow_up` 或 `continue`。

---

## 4. 心跳 tick 中的位置

```text
死亡检测
→ kpiCompletionJudge.sweep（程序化结案）
→ probe + judge
→ 战略 WHY+HOW
→ 质控（liveness / deliverable 趋势）
→ dispatch（不对 achieved KPI 再 set_goal）
```

`sweep` 在 autonomy **之前**，避免对已达成 KPI 误派 burst。

---

## 5. ADL 组件

| 模块 | 路径 | 职责 |
|------|------|------|
| **kpiCompletionJudge** | `outer/kpi-completion-judge.ts` | sweep + digest 摘要 |
| **kpi-progress** | `outer/kpi-progress.ts` | `suggestKpiAction` / `shouldAutoAchieveKpi` 纯函数 |
| **outerHeartbeat** | `outer/outer-heartbeat.ts` | 每 tick 调 sweep；工具含 list/view/achieve_kpi |
| **kpiBurstHooks** | onExit | 与 sweep 同规则，burst 退出时抢先 mark |

---

## 6. 修订

| 日期 | 说明 |
|------|------|
| 2026-06-02 | 初版：心跳 + 战略须含 KPI 完成判定；程序化 sweep |
| 2026-06-02 | workspace.dsl 边 + 视图 10b/11；Cursor rule `outer-heartbeat-tick.mdc` |

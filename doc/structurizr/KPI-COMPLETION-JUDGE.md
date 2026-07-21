# KPI 完成判定（ADL）

> **English:** Heartbeat watchdog and completion tools **must judge whether each active KPI is complete**—not only whether bursts are stuck. Programmatic sweep (`kpiCompletionJudge`) + LLM tools (`view_kpi` / `achieve_kpi`) form one pipeline. Autonomic continuation is owned by [`DIGITAL-EMPLOYEE-AUTONOMY.md`](./DIGITAL-EMPLOYEE-AUTONOMY.md), not by strategyPlanner.

与 [`KPI-CLOSED-LOOP.md`](./KPI-CLOSED-LOOP.md)、[`OUTER-HEARTBEAT-OVERSIGHT.md`](./OUTER-HEARTBEAT-OVERSIGHT.md)、[`KPI-MANAGER-LAYER.md`](./KPI-MANAGER-LAYER.md) 互补。旧 [`STRATEGY-PLANNING-LAYER.md`](./STRATEGY-PLANNING-LAYER.md) 仅历史对照。

---

## 1. 动机

- **burst 级** `is_post_complete` ≠ **KPI 级** `achieved`：监督类、多 burst 探索类 KPI 可能长期 active。
- onExit auto-achieve 已收敛到 `kpiCompletionJudge.sweep`；进程异常、对账滞后时 registry 仍可能 **active + suggestKpiAction=achieved**。
- 心跳 / SelfWorkPolicy / 用户须问：**这个 KPI 的目标是否已经达成？** 而非只问「内脑是否在跑」。

---

## 2. 判定分层

| 层 | 谁判 | 依据 | 产出 |
|----|------|------|------|
| **程序化** | `kpiCompletionJudge.sweep` | `suggestKpiAction` + 无在途 RUNNING + DONE/post_complete/deliverables | 自动 `markAchieved`（delivery） |
| **心跳 LLM** | legacy `runHeartbeat`（watchdog） | `list_kpis` / `view_kpi` digest；语义上目标已到手 | `achieve_kpi(evidence)` |
| **自主工作层** | `SelfWorkPolicy` / Ops | `burstRunHistory` + 长期目标；开放式 KPI 是否还值得做 | 提案 `null`、pause 建议、或显式 achieve |
| **用户** | IM / 外脑对话 | 用户明确「完成了」 | `achieve_kpi` 或 belief reconcile |

**勿混**：里程碑全完成 → 内脑 `is_post_complete`；KPI 达成 → registry `status=achieved`。

---

## 3. `suggestKpiAction → achieved` 条件（与代码一致）

active KPI 且**无** RUNNING 在途 burst 时，最近 burst 满足：

- `registryStatus === DONE` 且 `isPostComplete === true`
- `deliverableCount >= 1`
- 最近 `outcomeEvaluation.successConfirmed === true`（或等价 verdict `success` | `partial`）

监督类 / 未 post_complete → **不** achieved，继续 `follow_up` 或 `continue`。

**在途 burst 语义分层**（[`INNER-BRAIN-IM-NOTIFY-BOUNDARY.md`](./INNER-BRAIN-IM-NOTIFY-BOUNDARY.md) §8 · [`DIGITAL-EMPLOYEE-AUTONOMY.md`](./DIGITAL-EMPLOYEE-AUTONOMY.md)）：

| `suggestKpiAction` | 条件 | 外脑行为 |
|--------------------|------|----------|
| `awaiting_human` | `is_async_waiting` 且存在 `ask_user` pending | **正常等待依赖**；勿重复派**同一依赖工作**；**可**派同 KPI 不依赖该答案的独立工作 |
| `follow_up` | AWAITING 无 ask_user / safety_cap 循环 / 真 stuck | 介入、换路线或 reap |
| `continue` | RUNNING 正常推进，或 ongoing 交付后继续 | 观察 / 有容量则找其它价值工作 |
| `stuck_retry` | idle streak 达阈值 | SelfWorkPolicy 换方向；**不**无护栏自动 spawn |

`shouldAutoAchieveKpi`：`isAwaiting` 仍返回 false（与 §3 一致）。

---

## 3b. KPI 类型：`delivery` vs `ongoing`（防常驻任务被误结案）

> **动机**：用户的「24h 台湾情报：收集 + 扩源 + 高阶分析 + 每天两次报告」这类任务，本质是**永续 Mission**，不是一次「做完」的项目。当前模型只有 `active/paused/achieved/abandoned`，一旦某次 burst `post_complete + deliverable≥1`，`sweep` / `kpiBurstHooks` 就会把它 `achieved`——任务被**过早结案**，退化成「每天两次 cron」。

`KpiRecord` 增加判别字段：

```typescript
type KpiKind = 'delivery' | 'ongoing';
```

| kind | 语义 | 完成判定 |
|------|------|----------|
| **`delivery`**（默认） | 一次性交付目标（"通过 X 拿到 Y"） | 原规则：`post_complete + deliverable≥1 + verdict∈{success,partial,null}` → auto-achieve |
| **`ongoing`** | 常驻 / 周期 / 监督类（"持续收集情报并每日汇报"） | **禁止** auto-achieve；交付物只是**节拍产出**，KPI 始终 `active`，仅用户 / Ops / SelfWorkPolicy 建议后显式 `achieve_kpi` 或 `abandon_kpi` 才结案 |

**硬约束（与代码一致）**：

- `suggestKpiAction(kpi)`：`kpi.kind === 'ongoing'` 时**永不**返回 `achieved`；交付完成回 `continue`（reason=`ongoing 常驻：交付后继续巡检`）。
- `shouldAutoAchieveKpi({ kind, ... })`：`kind === 'ongoing'` 直接返回 `false`（先于其它判定）。
- `sweepKpiCompletions`：遍历 active 时 `kind === 'ongoing'` 直接跳过。
- `kpiBurstHooks.processBurstExitForKpi`：auto-achieve 分支加 `kind !== 'ongoing'` 闸门。

向下兼容：旧数据无 `kind` → `_normalize` 补 `'delivery'`，行为不变。

---

## 4. 心跳 tick 中的位置

```text
死亡检测
→ kpiCompletionJudge.sweep（程序化结案）
→ environment + capacity snapshot
→ 质控 / R3–R7 / Calendar missed
→ digitalEmployeeLoop(heartbeat_fallback)（补漏，非主时钟）
```

`sweep` 在自主填槽**之前**，避免对已达成 KPI 误派 burst。

---

## 5. ADL 组件

| 模块 | 路径 | 职责 |
|------|------|------|
| **kpiCompletionJudge** | `outer/kpi-completion-judge.ts` | sweep + digest 摘要 |
| **kpi-progress** | `outer/kpi-progress.ts` | `suggestKpiAction` / `shouldAutoAchieveKpi` 纯函数（含 `kind` 闸门） |
| **outerHeartbeat** | `outer/outer-heartbeat.ts` | watchdog 每 tick 调 sweep |
| **digitalEmployeeLoop** | `outer/digital-employee-loop.ts`（✅ P1） | 容量释放后找活；不负责结案 |
| **kpiFeedback** | `outer/kpi-feedback.ts` | momentum 反馈；供 SelfWorkPolicy 输入 |

---

## 6. 修订

| 日期 | 说明 |
|------|------|
| 2026-06-02 | 初版：心跳 + 战略须含 KPI 完成判定；程序化 sweep |
| 2026-06-02 | workspace.dsl 边 + 视图 10b/11；Cursor rule `outer-heartbeat-tick.mdc` |
| 2026-06-06 | §3b `KpiKind: delivery \| ongoing`：ongoing 永不 auto-achieve（防 24h 常驻任务被误结案） |
| 2026-07-21 | 数字员工对齐：去掉 strategyPlanner 现行职责；ask_user 不整 KPI 禁派；tick 改为 watchdog + fallback |

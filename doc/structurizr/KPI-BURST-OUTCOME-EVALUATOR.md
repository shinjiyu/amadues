# KPI Burst 结果评估（ADL · 历史评估器 + 现行反馈边界）

> **English:** On **KPI-linked** burst exit, outer brain may assemble outcome evidence. **Unguarded** `scheduleNextKpiBurst` / onExit auto-spawn is **removed**. Continuation is owned by [`DIGITAL-EMPLOYEE-AUTONOMY.md`](./DIGITAL-EMPLOYEE-AUTONOMY.md).

> 取代 per-burst `reflexion.json` / `reflexionTrail` / `scheduleReflexionBurst`。
> **现行**：burst exit 只写反馈（history / momentum / action-log），并触发 `burst_finished`；是否再派由 `digitalEmployeeLoop` + Calendar / SelfWorkPolicy 决定。
> 与 [`KPI-MANAGER-LAYER.md`](./KPI-MANAGER-LAYER.md)、[`KPI-BURST-LIFECYCLE-REMOVED.md`](./KPI-BURST-LIFECYCLE-REMOVED.md) 互补。

---

## 1. 分流

| 类型 | burst 结束 | 外脑行为 |
|------|------------|----------|
| **KPI**（有 `kpi_id`） | onExit | 落盘状态 + 可选 outcome/momentum 反馈 → **发出** `burst_finished`；**禁止**直接 spawn / `completionNotify` |
| **Ad-hoc**（无 `kpi_id`） | onExit | **直接** `completionNotify` → 用户；`ingestInnerOutput` → mem9；不评估、不写 KPI 续派 |
| **AWAITING + ask_user** | onExit | 不评估；`notifyInnerBrainAwaitingHuman`；等待只阻塞依赖项，释放员工容量 |

---

## 2. 结果包（BurstOutcomePackage）

| 部分 | 来源 | 禁止 |
|------|------|------|
| **摘要** | `deliverables.json` 路径 + 主产物 excerpt | 里程碑勾选表、内脑自评 verdict、「任务已完成」话术 |
| **过程** | `inner/tool-logs/<ws>/*.jsonl` 尾段、`memory.json` `node_results` / `last_failure`、`.run/pi-mono/logs` 尾段 | 整份灌入 mem9 |

模块：`outer/kpi/burst-process-report.ts`

---

## 3. 评估器 `kpiBurstOutcomeEvaluator`

**问什么：**

1. **是否真的成功？** — 看产物与过程信号，不看内脑自述完成。
2. **若失败，为何？** — `last_failure`、失败 node、工具 `ok:false`。
3. **是否换思路？** — 可将失败证据 / `suggestedRetryCharter` 写入反馈，供 `SelfWorkPolicy` 消费；**禁止**同 tick `scheduleNextKpiBurst` / onExit 直接 spawn（已删，见 [`KPI-BURST-LIFECYCLE-REMOVED.md`](./KPI-BURST-LIFECYCLE-REMOVED.md)）。

**P0 规则（程序化）：**

```text
successConfirmed =
  !exitedWithError
  && !(DONE && deliverableCount === 0 && !isAwaiting)
  && deliverableCount >= 1

failureReasons ← last_failure.message, node_results[*].status=failed, 近期 tool ok:false

suggestedRetryCharter ← 基于 failureReasons 的换角度章程；idle streak 达阈值时用更强 pivot 文案，**不**阻断续跑

markAchieved ← 仅当 outcomeEvaluation.successConfirmed（非 reflexion / 非「有 deliverable 即结案」）
```

**P1（可选）：** LLM 读摘要+过程 digest，产出 `evidenceSummary` + 建议 charter，作为 `SelfWorkPolicy` 输入（**不得**直接 spawn）。

模块：`outer/kpi/kpi-burst-outcome-evaluator.ts`

---

## 4. 落盘

`BurstRunRecord.outcomeEvaluation`:

```typescript
interface BurstOutcomeEvaluation {
  evaluatedAt: string;
  successConfirmed: boolean;
  confidence: 'high' | 'medium' | 'low';
  failureReasons: string[];
  evidenceSummary: string;
  suggestedRetryCharter?: string;
  processReportDigest: string;
}
```

---

## 5. 退役

| 退役 | 替代 |
|------|------|
| `write_memo` → mem9 `:tasks` | 删除（无人读） |
| per-burst `reflexion.json` → `reflexionTrail` | `outcomeEvaluation` |
| `scheduleReflexionBurst` / `POST /api/kpis/:id/reflect` | **已删除/410**；失败反馈供 SelfWorkPolicy；续派走 `digitalEmployeeLoop` |
| `evaluateKpiAutonomyDispatch` 的 `kpi_stuck_reflexion` 硬挡 | 移除；`suggestKpiAction.stuck_retry` 提示 SelfWorkPolicy / outcome 换向 |
| burst onExit 事实晋升 | `record_fact` 实时 `sharedFactSink`（见 `DRIVE9-KNOWLEDGE-SHARED.md`） |

`reflexionTrail` 已从 registry 类型移除（旧盘加载时 strip）。续跑 goal 读 `burstRunHistory`。

---

## 6. 测试

| 模块 | 单测 | 组件测 |
|------|------|--------|
| burstProcessReport | `burst-process-report.test.ts` | — |
| kpiBurstOutcomeEvaluator | `kpi-burst-outcome-evaluator.test.ts` | ⏳ `kpiBurstHooks` + fixture |

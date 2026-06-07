# KPI Burst 结果评估（ADL）

> **English:** On **KPI-linked** burst exit, outer brain assembles a **summary + process report**, then **`kpiBurstOutcomeEvaluator`** judges success and may schedule a **retry charter**. **Ad-hoc** bursts skip evaluation and notify the user directly.

> 取代 per-burst `reflexion.json` / `reflexionTrail` / `scheduleReflexionBurst` 作为 KPI 战术反馈主路径。  
> 与 [`KPI-ADVANCEMENT.md`](./KPI-ADVANCEMENT.md) §6 `burstRunHistory`、`TASK-RUN-OBSERVABILITY.md` 互补。

---

## 1. 分流

| 类型 | burst 结束 | 外脑行为 |
|------|------------|----------|
| **KPI leaf**（`kpi_id` 挂接） | onExit | 组装结果包 → **评估** → 写入 `burstRunHistory.outcomeEvaluation` → 失败可 **换 charter 续跑**；**禁止** `completionNotify` / `ingestInnerOutput` |
| **Ad-hoc**（无 `kpi_id`） | onExit | **直接** `completionNotify` → 用户；`ingestInnerOutput` → mem9；不评估、不写 KPI 史 |
| **AWAITING + ask_user** | onExit | 不评估、不续跑；`notifyInnerBrainAwaitingHuman`（KPI/ad-hoc 均可） |

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
3. **是否换思路重试？** — 写 `suggestedRetryCharter` → `kpi.charter` + 可选同 tick `scheduleNextKpiBurst`。

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

**P1（可选）：** LLM 读摘要+过程 digest，产出 `evidenceSummary` + charter（注入 `strategyPlanner`）。

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
| `scheduleReflexionBurst` / `POST /api/kpis/:id/reflect` | 评估失败 → `suggestedRetryCharter` + `scheduleNextKpiBurst`；reflect API **410** |
| `evaluateKpiAutonomyDispatch` 的 `kpi_stuck_reflexion` 硬挡 | 移除；`suggestKpiAction.stuck_retry` 提示战略层 / outcome 换向 |
| burst onExit 事实晋升 | `record_fact` 实时 `sharedFactSink`（见 `DRIVE9-KNOWLEDGE-SHARED.md`） |

`reflexionTrail` 字段保留只读兼容；不再 append。续跑 goal 读 `burstRunHistory`，不读 trail。

---

## 6. 测试

| 模块 | 单测 | 组件测 |
|------|------|--------|
| burstProcessReport | `burst-process-report.test.ts` | — |
| kpiBurstOutcomeEvaluator | `kpi-burst-outcome-evaluator.test.ts` | ⏳ `kpiBurstHooks` + fixture |

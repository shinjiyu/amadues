# 节点触顶告警（Burst No-Progress / Cap Alert）

> 产品/UI 称 **「节点触顶」**；代码路径仍为 `stall-alerts`（历史命名）。  
> 与 [`DYFLOW-INNER-EXECUTOR.md`](./DYFLOW-INNER-EXECUTOR.md) §6.5（shell I/O stall）、[`TASK-RUN-OBSERVABILITY.md`](./TASK-RUN-OBSERVABILITY.md) 互补。  
> **目标**：DyFlow **NODE** 达 `INNER_BASE_NODE_MAX_ROUNDS`（`safety_cap` / `status=capped`）且 burst 仍无 facts / deliverable 时 **立即** 落盘定位包。  
> **勿与**：burst `UTLRA_PI_AUTO_MAX_TICKS`、DESIGN `empty` streak、外脑 KPI `idle` 调度混淆。

---

## 1. 原则

| 原则 | 说明 |
|------|------|
| **事件驱动** | 在 `failure.distill`、节点 `safety_cap` / `fail_fast` 后评估，不依赖外脑心跳 |
| **一次 burst 可多次告警** | 信号加重或 debounce 窗口（默认 2min）过后可再报 |
| **只追加、不覆盖** | 每次告警独立 JSON + `index.jsonl` 索引 |
| **Cursor 友好** | 包内 `cursor.paths[]` 为相对仓库根路径；`cursor.snippet` 可复制到 Agent |

---

## 2. 空转判定（`burstStallEvaluator`）

满足 **任一** 即 `stalled: true`：

| 信号 ID | 条件 |
|---------|------|
| `multi_cap_no_facts` | `node_results` 中 `capped` ≥ 2 **且** `memory.facts` 为空 |
| `multi_cap_zero_ok` | `capped` ≥ 2 **且** 无任何 `ok: true` 节点 |
| `capped_nodes_3` | `capped` ≥ 3 |
| `run_failure_constraints_4` | `[run-failure]` constraints ≥ 4 |
| `long_run_no_outcome` | 注册表 `startedAt` 起 **≥15min** 且 facts=0 且 deliverableCount=0 |

`severity`：`critical` 若 `capped_nodes_3` 或 `long_run_no_outcome`；否则 `warn`。

环境变量：

| 变量 | 默认 |
|------|------|
| `INNER_BURST_STALL_ALERT` | `1`（`0`/`false` 关闭） |
| `INNER_BURST_STALL_DEBOUNCE_MS` | `120000` |
| `INNER_BURST_STALL_LONG_RUN_MS` | `900000`（15min） |

---

## 3. 落盘布局（`DATA_ROOT`）

```
stall-alerts/
  index.jsonl              # 每条一行索引（全 agent 共享 data root）
  <instanceId>/
    <iso-safe-ts>_<alertId>.json   # 完整告警包（权威）
```

告警包 schema：`burst-stall-alert.v1`（见 `burst-stall-alert.ts`）。

**包内容**：verdict、memory/dyflow 快照、deliverables 摘要、pi-mono 日志尾、inner tool-audit 尾、registry 条目、**cursor** 块。

---

## 4. 模块

| 模块 ID | 路径 | 职责 |
|---------|------|------|
| **burstStallEvaluator** | `inner-brain/burst-stall-evaluator.ts` | 纯函数判定 |
| **burstStallAlert** | `inner-brain/burst-stall-alert.ts` | 写包 + index + debounce |
| **dyflowController** | `inner-brain/controller.ts` | RUN 失败 distill 后 `maybeEmitBurstStallAlert` |

HTTP（agent-server）：

| 路由 | 说明 |
|------|------|
| `GET /api/stall-alerts?limit=30` | 最近告警索引（Dashboard） |
| `GET /api/stall-alerts/:alertId` | 单包全文（可选 `?full=1`） |

Dashboard：`StallAlertsPanel`（独立 Tab「空转」），轮询索引；点击展开 cursor 路径与摘要。

---

## 5. 与 shell stall 的区别

| | shell stall guard | burst stall alert |
|--|-------------------|-------------------|
| 粒度 | 单节点内重复 shell | 整 burst 无产出 |
| 动作 | transient failure 上交 | **落盘告警包**，不强制停 burst |
| 消费方 | Runner 内 | 人 / Dashboard / Cursor |

---

## 6. 测试

| 测试 | 路径 |
|------|------|
| 单测 | `burst-stall-evaluator.test.ts`、`burst-stall-alert.test.ts` |
| 组件 | ⏳ controller 集成「cap→index 有一行」 |

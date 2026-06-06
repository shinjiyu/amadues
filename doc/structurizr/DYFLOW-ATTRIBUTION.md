# DyFlow 强制归因（RUN → ATTRIBUTE → DESIGN）

> **English:** Restore a **Mandatory Attributor** between RUN and DESIGN (legacy `ATTRIBUTE` mode, DyFlow-adapted). Distills execution logs into `memory.facts` / `memory.constraints` before Designer replans.

> **状态**：2026-06-06 定稿 · 实现于 `inner-brain/attributor.ts` + `run-context-store.ts`

---

## 1. 动机

| 现象（bot2 A/B） | 根因 |
|------------------|------|
| `memory.facts` 长期为空；`rawTail` 有干货却不入库 | RUN 后无归因；`failure-distill` 只写模板 constraint |
| Designer「反思」不稳定 | 编排压力 > 蒸馏任务；`record_fact` 在 baseNode 几乎不被调用 |
| Bot3 进度明显更快 | Legacy **每段 EXECUTE 后** Attributor 写 `knowledge.md` / `constraints.md` |

DyFlow 保留 **单 burst、单作品**（不外脑多 burst 分叉），补上 **框架强制归因**。

---

## 2. FSM 变更

```text
DESIGN → RUN → ATTRIBUTE → DESIGN | AWAITING
```

| mode | 动作 |
|------|------|
| **ATTRIBUTE** | 读 `.brain/run-context.json` → LLM 归因（`record_fact` / `record_constraint`）→ 清 run-context → 失败时叠加 `failure-distill` 模板 |

转移：

```text
RUN       → ATTRIBUTE   : 图跑完（成功或失败）；写入 run-context
ATTRIBUTE → DESIGN      : 归因完成；无 active pendings
ATTRIBUTE → AWAITING    : 归因完成；有 pendings
```

**不变**：Designer 仍只编排；baseNode 仍猛猛干。归因与规划解耦。

---

## 3. run-context.json

RUN 结束时 Runner 持久化（供 Attributor 读，归因后删除）：

```text
RunContext {
  burstId, designedAt, finishedAt, ok, failedAt?, dagNotes?,
  nodes: [{
    nodeInstId, ref, ok, status?, instruction?, deliverable?,
    failureSummary?, rawTail?,
    entries: ExecutionEntry[]   // 每格 baseNode 工具链（截断保底）
  }]
}
```

路径：`.brain/run-context.json`（与 legacy `execution-context.json` 同层级语义，DyFlow 专用 schema）。

---

## 4. Attributor

| 项 | 值 |
|----|-----|
| 模块 | `openkuroneko/inner-brain/attributor.ts` |
| 工具 | `record_fact`, `record_constraint`（仅归因阶段） |
| 轮次上限 | `INNER_ATTRIBUTOR_MAX_ROUNDS`（默认 20） |
| 输入 | run-context + memory.goal/constraints/facts 摘要 |
| 输出 | 写入 `memory.json`；无 CONTROL flag（换向仍由 Designer） |

任务顺序（prompt）：

1. 分析各节点 execution log（进展/失败根因）
2. **事实**：稳定、可复用 → `record_fact`（前缀 `[事实]` 可选）
3. **红线/避坑**：应永久避免的模式 → `record_constraint`（`[红线]` / `[避坑]` / `[run-failure]` 由模型择一）
4. 成功节点也要蒸馏（Playwright 可行、脚本路径、API 形状等）

LLM 失败时：记 warn，仍执行 `failure-distill`（仅 RUN 失败），进入 DESIGN。

---

## 5. failure-distill 定位

- **主路径**：Attributor LLM 蒸馏事实与领域 constraint
- **兜底**：RUN `ok=false` 时 Attributor 之后仍跑 `distillRunFailures`（模板 `[run-failure]`，防裸重试）

---

## 6. 资源预算（`resource-budget.ts`，与 baseNode / Designer 同源）

| 变量 | 默认 | 告知 |
|------|------|------|
| `INNER_ATTRIBUTOR_MAX_ROUNDS` | 20 | system 静态上限 + **每轮** live 用量（`DYFLOW-INNER-EXECUTOR.md` §6.1d） |

---

## 7. 测试

| 类型 | 文件 |
|------|------|
| 单元 | `attributor.test.ts`, `run-context-store.test.ts` |
| 组件 | `controller.component.integration.test.ts`（RUN→ATTRIBUTE→DESIGN） |

---

## 8. 变更记录

| 日期 | 说明 |
|------|------|
| 2026-06-06 | 初版：恢复 ATTRIBUTE；run-context；Mandatory Attributor |

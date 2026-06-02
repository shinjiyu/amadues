# 框架调优基准（Framework Benchmark）

> **English:** Fixed **FakeLLM scenarios** with **token proxy metrics** establish a baseline before tuning Executor, burst policy, or knowledge reuse. Real LLM snapshots are a separate tier (L2).

与 [`COMPONENT-TESTING.md`](./COMPONENT-TESTING.md) 互补：组件测证明「模块没坏」；本文证明「框架调优是变好还是变差」。

---

## 1. 目标

| 目标 | 说明 |
|------|------|
| **固定场景** | 同一输入 → 可重复跑；不依赖元宝/PS 等业务任务 |
| **Token 基线** | 用 FakeLLM 调用量 + **estimatedPromptTokens**（字符/4 启发式）作调优尺子 |
| **回归门禁** | CI 集成测：指标不得劣于 committed `baseline.json`（除非显式 bump） |

**第一步（当前）**：固定场景 + 记 token  proxy；调优 Executor / 复用 / 派活后对比 baseline。

---

## 2. ADL 模块

| 模块 ID | 路径 | In → Out |
|---------|------|----------|
| **frameworkBenchmarkHarness** | `packages/server/src/benchmark/` | `runFrameworkBenchmark()` → `FrameworkBenchmarkReport` |
| **frameworkBenchmarkBaseline** | `packages/server/src/benchmark/baseline.json` | committed 指标上限 |

---

## 3. 场景表（L1 · FakeLLM）

| ID | 名称 | 测什么 | 关键指标 |
|----|------|--------|----------|
| **S1** | `single-burst-complete` | DECOMPOSE → EXECUTE → ATTRIBUTE 最短 happy path | `llmCalls`, `estimatedPromptTokens`, `ticks` |
| **S2** | `executor-multi-round` | EXECUTE 内 N 轮 tool+LLM（模拟 read 循环） | `executorLlmCalls`, `estimatedPromptTokens`, `maxExecutorRound` |

后续扩展（⏳）：S4 peer-reuse、S6 exec-kill-resume（见 [`doc/todo/inner-brain-exec-kill-resume-stuck.md`](../todo/inner-brain-exec-kill-resume-stuck.md)）。

---

## 4. 指标定义

```typescript
interface ScenarioMetrics {
  llmCalls: number;              // FakeLLM.chat 次数
  estimatedPromptTokens: number; // Σ ceil((system+messages)/4) 每 call
  ticks: number;                 // controller.tick 直到 hadWork=false
  executorLlmCalls: number;      // matchedLabel 含 executor / 反应执行器
  maxExecutorRound: number;      // executor 单 milestone 内最大 round（日志）
  toolCalls: number;             // executor tool.call 次数（若可观测）
  wallMs: number;
}
```

**调优判据**（同一 scenarioId）：

1. `passed` 仍为 true  
2. `estimatedPromptTokens` **≤ baseline**（或 PR 中 intentional bump 并更新 baseline.json）  
3. `llmCalls` / `executorLlmCalls` 同上  

---

## 5. 运行

```bash
npm run benchmark:framework -w @utlra/server   # 打印报告 + 写 benchmark-last.json
npm run test:integration -w @utlra/server      # 含 framework-benchmark 回归
```

Bump baseline（指标预期上升时）：

```bash
npm run benchmark:framework:bump -w @utlra/server
```

---

## 6. 与 Token 调优的关系

| 调优点 | 先看场景 |
|--------|----------|
| `MAX_EXEC_ROUNDS`、tool 结果 summarization | **S2** |
| Decomposer / ATTRIBUTE prompt 瘦身 | **S1** |
| 跨 burst read 去重 | S4（待建） |
| 全链路 spawn 次数 | agent-stack 场景（待建） |

---

## 7. 修订

| 日期 | 说明 |
|------|------|
| 2026-06-02 | 初版：S1/S2 + baseline.json + harness |

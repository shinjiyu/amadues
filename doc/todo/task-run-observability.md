# 真实任务观测（调优基线）

> **ADL**：[`doc/structurizr/TASK-RUN-OBSERVABILITY.md`](../structurizr/TASK-RUN-OBSERVABILITY.md)  
> **状态**：P0 已实现（analyzer + compare）；Exporter / Registry 待 P1

## 已实现

| 脚本 | 说明 |
|------|------|
| `scripts/observe/analyze-run.mjs` | DATA_ROOT + 时间窗 → RunReport |
| `scripts/observe/compare-runs.mjs` | 两份 Report → DELTA |
| `scripts/observe/README.md` | CLI 用法 |

**落盘**：默认 `D:\kuroneko-observations\`（或 `KURONEKO_OBSERVATIONS_DIR`），切 branch 不丢。

**首份 baseline**：`kuroneko-observations/runs/pokemon/2026-06-01T18-20-03Z-yuanbao-baseline-v0/`（元宝全量 ~48M tokens / 81 bursts）

## P1 待做

## 标定任务（各一句）

- **novel**：KPI/外脑驱动下完成一部长篇小说（多章节 deliverable）。
- **pokemon**：Pokemon Showdown 注册/登录/对战闭环（Playwright 或 WS，多 burst）。

## 调优怎么判

同一任务、同一 runKind 下对比两次 **RunReport**：

- outcome 不降级（deliverable / 实战 log / 完稿）
- `totalTokens` 或 `tokensPerDeliverable` 下降 → 调优有效

## P1 待做

1. `scripts/observe/export-run.mjs` — 一键打包 export
2. `taskRunRegistry` — run 边界标记
3. Dashboard Runs 面板

FakeLLM 基准（`packages/server/src/benchmark/`）与本文无关，可忽略。

# 框架 Token 调优基线（第一步）

> **状态**：S1/S2 已落地（2026-06-02）  
> **ADL**：[`doc/structurizr/FRAMEWORK-BENCHMARK.md`](../structurizr/FRAMEWORK-BENCHMARK.md)

## 用法

```bash
# 跑场景 + 对比 baseline.json
npm run benchmark:framework -w @utlra/server

# 调优后指标下降（变好）→ 无需操作，CI 自动绿
# 调优导致指标上升（预期内，如改了场景）→ bump baseline
npm run benchmark:framework:bump -w @utlra/server
```

## 当前基线（committed）

| 场景 | estPromptTokens | llmCalls | 说明 |
|------|-----------------|----------|------|
| **S1** single-burst-complete | **1769** | 4 | 最短 DECOMPOSE→EXECUTE→ATTRIBUTE |
| **S2** executor-multi-round | **3645** | 7 | EXECUTE 5 轮 read_file 循环 |

**调优 Executor 时优先看 S2 的 `estimatedPromptTokens`。**

## 下一步

- S4 peer-reuse（跨 burst read 次数上限）
- L2 真 LLM 微场景 snapshot（可选 nightly）

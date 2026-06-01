# LLM Token 用量统计（ADL）

> 与 `workspace.dsl`、`components/agent-server.dsl` 同步。  
> 依赖：[`RESOURCE-AWARENESS-AUTONOMY.md`](./RESOURCE-AWARENESS-AUTONOMY.md) 中的 **llmUsageTracker**（运行时滚动窗口）。

## 1. 动机

`llmUsageTracker` 仅提供进程内 **1h 滚动窗口**，重启清零，无 per-model / per-source 维度，Dashboard 不可查。

本设计在 tracker 之上增加 **持久化 journal + 聚合 API + Dashboard 面板**。

## 2. 模块

| 模块 ID | 路径 | 职责 |
|---------|------|------|
| **llmUsageTracker** | `outer/llm-usage-tracker.ts` | in-flight + 内存滚动窗口（resourceProbe） |
| **llmUsageJournal** | `outer/llm-usage-journal.ts` | 追加 `usage/llm-usage.jsonl`；按 source/model 聚合 |

## 3. 存储

- 路径：`<DATA_ROOT>/usage/llm-usage.jsonl`
- 每行一条 `LlmUsageJournalEntry`（ISO 时间、source、model、tokens、agentId、可选 workspace/instance/thread）

## 4. 采集点

| source | 路径 |
|--------|------|
| `outer_conversation` | `outer/outer-conversation-loop.ts` |
| `outer_heartbeat` | `outer/outer-heartbeat.ts` |
| `autonomy` | `outer/autonomy-task-dispatcher.ts` |
| `performance_goal` | `performance-goals/engine.ts` |
| `inner_llm_step` | `llm/raw.ts`（经 provider） |
| `inner_pi_mono` | `openkuroneko/adapter/openai.ts`（流式末 chunk usage） |
| `probe` | `index.ts` `/api/models/probe` |

## 5. HTTP

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/usage/summary?hours=24` | 聚合 + runtime snapshot + recent |

## 6. Dashboard

`apps/dashboard` 新增 **用量** Tab：`UsagePanel` 只读展示 summary。

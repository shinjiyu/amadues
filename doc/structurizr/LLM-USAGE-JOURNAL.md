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
- 每行一条 `LlmUsageJournalEntry`（ISO 时间、source、model、tokens、可选 `cachedPromptTokens`、agentId、可选 workspace/instance/thread）

## 4. 采集点

| source | 路径 |
|--------|------|
| `outer_conversation` | `outer/outer-conversation-loop.ts` |
| `outer_heartbeat` | `outer/outer-heartbeat.ts` |
| `autonomy` | `outer/casual-chat-dispatcher.ts` |
| `performance_goal` | `performance-goals/engine.ts` |
| `inner_llm_step` | `llm/raw.ts`（经 provider） |
| `inner_pi_mono` | `openkuroneko/adapter/openai.ts`（流式；`stream_options.include_usage` + 无 usage 时仍记 call） |
| `probe` | `index.ts` `/api/models/probe` |

内脑子进程启动时 `inner-brain-worker.ts` 会 `configureLlmUsageTracker`（继承 `UTLRA_DATA_ROOT`），保证 journal 写入 agent 级 `usage/llm-usage.jsonl`。

流式请求默认带 `stream_options: { include_usage: true }`；若网关不支持可设 `LLM_STREAM_INCLUDE_USAGE=0`（仍记 call 次数，token 可能为 0）。

## 5. HTTP

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/usage/summary?hours=24` | 聚合 + runtime snapshot + recent |

## 6. Dashboard

`apps/dashboard` 新增 **用量** Tab：`UsagePanel` 只读展示 summary。

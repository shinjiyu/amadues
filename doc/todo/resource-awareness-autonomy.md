# 资源感知与心跳自主调度（实现待办）

> ADL：[`RESOURCE-AWARENESS-AUTONOMY.md`](../structurizr/RESOURCE-AWARENESS-AUTONOMY.md)

**状态**：**P0 已实现**（2026-05-29）

## P0 — 可观测 + 规则 dispatch

- [x] `outer/llm-usage-tracker.ts` — in-flight + usage 滚动窗口
- [x] `outer/resource-probe.ts` — `ResourceSnapshot`
- [x] `outer/autonomy-policy-store.ts` — `policy.json` + 默认 hardGates
- [x] `outer/personality.ts` — 读写 `outer/personality.json`（`idleChatProbability`）
- [x] `outer/autonomy-judge.ts` — **仅** `evaluateHardGates()` → idle/busy
- [x] `outer/autonomy-task-dispatcher.ts` + `autonomy-task-state.ts`
  - [x] **阶梯**：`hasKpi && canSpawn` → `kpi_inner_goal`
  - [x] **否则**候选闲聊 → `Math.random() < idleChatProbability`
- [x] `outer-heartbeat.ts` — tick：probe → gates → dispatch（dispatch 成功则 skip legacy LLM）
- [x] `llm/raw.ts` — hook `beginLlmCall` / `endLlmCall` / `recordLlmUsageFromResponse`
- [x] `action-log.jsonl`
- [x] 单测：`autonomy-judge.test.ts`、`autonomy-task-dispatcher.test.ts`

## P1 — 执行细节 + 聊天改配置

- [x] `kpi_inner_goal` — kpiRegistry 选题 + LLM 写 goal + `set_goal`
- [x] `casual_chat` — participation 频控 + soul 注入 + IM post
- [x] `outer-tools.ts` — `read/update_autonomy_policy`、`update_personality`
- [x] 集成测：`autonomy-heartbeat.component.integration.test.ts`

## P2 — 增强

- [ ] soft LLM 闲忙（`policy-rubric.md`）
- [x] Dashboard **用量** Tab（`UsagePanel` + `GET /api/usage/summary`）— 见 [`LLM-USAGE-JOURNAL.md`](../structurizr/LLM-USAGE-JOURNAL.md)
- [ ] 更多 `AutonomyTaskHandler`

## 参考

- 心跳：`packages/server/src/outer/outer-heartbeat.ts`
- 性格：`packages/server/src/outer/soul.ts`（自然语言）+ **`personality.json`（概率）**
- KPI：`packages/server/src/outer/kpi-registry.ts`

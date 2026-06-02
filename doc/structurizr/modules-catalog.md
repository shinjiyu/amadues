# 模块视界目录（细粒度 · 与 workspace.dsl 同步）

> 对齐规则见 [`GRANULARITY.md`](./GRANULARITY.md)。**一模块 = 一事 + 可写清 In/Out**。

---

## L2 容器（进程 / 包）

见 `workspace.dsl` 中 `chatIrLib`、`agentServer`、`innerWorker` 等容器级 `horizon.*`。

**L1 约定（系统上下文）**：

- **用户**只经 **IM 接口**（`discord`、`localWebChatIm`）使用系统，**不**直连 `kuroneko` Agent API。
- **本地 IM** 在 L1 为 `localWebChatIm`，L2 由 `chatServer` + `webChat` 实现。
- **内外脑监控** 在 L1 为 `brainMonitoring`，L2 由 `opsConsole` + `performanceDashboard` 实现；**运维/观察者** 与终端用户分离。

---

## L3 — 外脑模块（`agentServer` 进程）

| 模块 ID | 职责 | 主路径 | In → Out |
|---------|------|--------|----------|
| **participationPolicy** | **是否说话 / 是否回复** | `outer/inbound-policy.ts` + `participation-state.ts` | `OuterInboundMeta` → `shouldReply` / SPEAK·SILENT |
| outerBrainFacade | 外脑编排入口 | `outer/outer-brain.ts` | `ChatIRInboundEvent` → 调 loop / policy |
| knowledgeRetrieval | 知识检索 | `outer/knowledge-retrieval.ts` | query → K/S/P 片段 |
| threadOrchestrator | 线程串行 + mention 感知 freshCheck + FIFO 排队 | `outer/thread-orchestrator.ts`; `chat-ir/seen-tracker.ts` | thread ops |
| outerConversationLoop | 外脑多轮 LLM | `outer/outer-conversation-loop.ts` | context → tool_calls |
| outerToolExecutor | 外脑工具执行 | `outer/outer-tools.ts` | tool_call → reply/spawn |
| **workspaceInbox** | **同 KPI peer 互读 + `.inbox/` 目录** | `outer/workspace-inbox.ts` | peer ids → catalog（名字/摘要） |
| outerOrchestrator | M6 roundtrip | `outer/orchestrator.ts` | 入站 → reply + spawn |
| innerBrainKpiReuse | KPI 单实例复用 | `outer/inner-brain-kpi-reuse.ts` | `findCanonicalBurstForKpi`；续跑不新开 workspace |
| innerBrainRegistry | 内脑任务表 | `outer/inner-brain-registry.ts` | spawn/stop → TaskRecord；`markStaleRunningAsStopped` |
| innerBrainStartupResume | **外脑重启恢复 RUNNING** | `outer/inner-brain-startup-resume.ts` | 启动 → 同一 instance 再 spawn |
| brainAsyncSnapshot | workDir 异步快照 | `outer/brain-async-snapshot.ts` | workDir → `is_post_complete` 等 |
| registryLifecycleReconcile | **registry↔workDir 对账** | `outer/registry-lifecycle-reconcile.ts` | 假 AWAITING → DONE |
| awaitingInboundResolver | **IM 回复解 pending** | `outer/awaiting-inbound-resolver.ts` | human IM → resolve → changeWatcher spawn |
| innerSpawner | spawn 子进程 | `pi-mono/inner-brain-spawner.ts` | goal/workDir → child |
| kpiRegistry | KPI 与反思 burst | `outer/kpi-registry.ts` | set_kpi → trail / idleStreak |
| kpiBurstHooks | burst 退出 hook | `outer/kpi-burst-hooks.ts` | reflexion.json → trail；streak → meta；AUTO_NEXT → 下一 burst |
| **kpiCompletionJudge** | **KPI 完成判定（心跳 sweep）** | `outer/kpi-completion-judge.ts` | active KPI → achieved / digest |
| **nodeDefDrive9Store** | **drive9 `/nodes/shared/` 客户端（P1）** | `drive9/node-def-drive9-store.ts` | put/search/tombstone NodeDef + index |
| **nodeDefEviction** | **NodeDef 治理 sweep（P2，外脑心跳级）** | `outer/node-def-eviction.ts` | dedupe + quota + cold tombstone |
| outerMemory | mem9 记忆 | `outer/outer-memory.ts` | chat/task → mem9 |
| **memoryBlockStore** | **结构化 Block CRUD** | `outer/memory-block-store.ts` + `memory-block-tools.ts` | `memory_block_*`；bind → `.brain/secrets/` |
| completionNotify | 完成通知（IM 精简） | `outer/completion-notify.ts` + `completion-report.ts` | DONE → `audience=im` 正文 + 附件 |
| pushLoop | 消费 worker 输出 | `outer/push-loop.ts` | `.run` events → 渠道 |
| changeWatcher | AWAITING 唤醒 | `pi-mono/change-watcher.ts` | bootstrap + pendings 到期/解封 → spawn |
| llmGateway | LLM 调用 | `llm/` | messages → text/tools |
| **outerHeartbeat** | **定时心跳 + 内脑质控 + 死亡检测** | `outer/outer-heartbeat.ts` | tick → 验收效果 / 卡死判定 / post_to_im / set_goal |
| **llmUsageTracker** | **LLM token/并发计量** | `outer/llm-usage-tracker.ts` | completion → 滚动 usage + journal |
| **llmUsageJournal** | **Token 统计持久化** | `outer/llm-usage-journal.ts` | entry → `usage/llm-usage.jsonl` + summary API |
| **resourceProbe** | **资源感知快照（P0；P1 起被 environmentSensorRegistry 替代）** | `outer/resource-probe.ts` | registry/tracker → ResourceSnapshot |
| **environmentSensorRegistry** | **环境模型 — 传感器注册表（P1）** | `outer/environment/sensor-registry.ts` | sensors[].read → EnvironmentSnapshot |
| **environmentJournal** | **环境模型 — 时序日志（ring + events.jsonl + hourly.jsonl）** | `outer/environment/journal.ts` | snapshot/events → 三层留存 + 未消费查询 |
| **environmentChangeDetector** | **环境模型 — 派生指标 + 事件检测（hysteresis/warmUp/zScore）** | `outer/environment/change-detector.ts` | prev/next → derived + events |
| **autonomyPolicyStore** | **闲忙规则（可聊天改）** | `outer/autonomy-policy-store.ts` | policy.json + rubric.md |
| **autonomyJudge** | **闲忙判定（hard gates；P1 读派生量）** | `outer/autonomy-judge.ts` | snapshot+policy → idle/busy |
| **agentPersonality** | **性格参数（闲聊概率）** | `outer/personality.ts` | personality.json → idleChatProbability |
| **autonomyTaskDispatcher** | **自主任务分发（P0 自由选 KPI；P1 起按 strategy.focusOrder）** | `outer/autonomy-task-dispatcher.ts` | strategy + 资源 → set_goal/post_to_im |
| **strategyStore** | **战略真相（current.json + journal.jsonl）** | `outer/strategy/strategy-store.ts` | StrategyArtifact CRUD + journal append |
| **strategyPlanner** | **战略 REFLECT + DESIGN（事件驱动重评估）** | `outer/strategy/strategy-planner.ts` | env+kpi+lessons → StrategyArtifact |
| **staleBurstReaper** | **杀僵尸（cullDirectives + maxAwaitingMs 兜底；ABORTED 状态迁移）** | `outer/strategy/stale-burst-reaper.ts` | strategy + registry → ABORTED + archive |
| performanceGoalEngine | 长期绩效目标审阅 | `performance-goals/engine.ts` | goals → heartbeat block |

**视图**（Structurizr，按路径拆开避免一张图过密）：

| 视图 | 内容 |
|------|------|
| `06-L3-Outer-AllModules` | 全部外脑组件 + 所有 L3 边 |
| `07-L3-Outer-Inbound-IM` | IM 入站：Facade → **awaitingInboundResolver** → 检索/记忆/是否说话 → 对话环 → 工具 |
| `07b-L3-Outer-Inbound-HTTP` | HTTP roundtrip：Orchestrator → policy → 直 spawn |
| `08-L3-Outer-Inner-Lifecycle` | spawn、**startupResume**、**reconcile**、registry、changeWatcher、pushLoop、completionNotify、KPI |
| `10-L2-KPI-Closed-Loop` | L2：agentServer ↔ innerWorker |
| `10b-L3-Outer-KPI` / `10c-L3-Inner-Reflexion` | L3 外脑调度 / 内脑反思分图 |
| **`11-L3-Outer-Autonomy`** | **心跳：probe → gates → 战略 WHY+HOW → 质控 → KPI dispatch** |
| **`12-L3-Outer-Environment`** | **环境模型：sensor registry / journal / change detector / 消费方** |
| **`13-L3-Outer-Strategy`** | **战略层：reflect/design + reaper + dispatch** |

**KPI 闭环**（实现与 ADL）：见 [`KPI-CLOSED-LOOP.md`](./KPI-CLOSED-LOOP.md)。

**KPI 完成判定**：见 [`KPI-COMPLETION-JUDGE.md`](./KPI-COMPLETION-JUDGE.md)。  
**心跳内脑质控**（验收效果 + 卡死/restart 把控）：见 [`OUTER-HEARTBEAT-OVERSIGHT.md`](./OUTER-HEARTBEAT-OVERSIGHT.md)。  
**资源感知与心跳自主调度**（P0 ADL）：见 [`RESOURCE-AWARENESS-AUTONOMY.md`](./RESOURCE-AWARENESS-AUTONOMY.md)。  
**环境模型**（P1 起替代 resourceProbe）：见 [`ENVIRONMENT-MODEL.md`](./ENVIRONMENT-MODEL.md)。  
**战略规划层**（P1 心跳重构）：见 [`STRATEGY-PLANNING-LAYER.md`](./STRATEGY-PLANNING-LAYER.md)。

**外脑重启恢复内脑**（实现与 ADL）：见 [`INNER-BRAIN-RESUME.md`](./INNER-BRAIN-RESUME.md)。

**AWAITING 生命周期**：[`INNER-BRAIN-AWAITING-LIFECYCLE.md`](./INNER-BRAIN-AWAITING-LIFECYCLE.md)。  
**内脑上游 Inbox**：[`INNER-WORKSPACE-INBOX.md`](./INNER-WORKSPACE-INBOX.md)。  
**内脑文件访问（大文件）**：[`INNER-FILE-ACCESS.md`](./INNER-FILE-ACCESS.md)。  
**Memory Block**：[`MEMORY-BLOCKS.md`](./MEMORY-BLOCKS.md)。

**记忆/知识边界**（P3c）：见 [`MEMORY-STORAGE-BOUNDARY.md`](./MEMORY-STORAGE-BOUNDARY.md)。

**测试**（按 component）：[`COMPONENT-TESTING.md`](./COMPONENT-TESTING.md) · 清单 [`COMPONENT-TEST-MAP.md`](./COMPONENT-TEST-MAP.md)

**双入口**：生产 IM 走 `outerBrainFacade`；`POST /api/outer/roundtrip` 走 `outerOrchestrator`（spawn 可不经过 registry）。

---

## L3 — 内脑模块（`innerWorker` 子进程）

> **DyFlow 单引擎**：旧三件套 `decomposer / executor / attributor / blockResolver` 及 `reflexion` 已删除（不再有 `INNER_BRAIN_ENGINE` 切换）。详见 [`DYFLOW-INNER-EXECUTOR.md`](./DYFLOW-INNER-EXECUTOR.md)、[`INNER-NODE-LIFECYCLE.md`](./INNER-NODE-LIFECYCLE.md)。

| 模块 ID | 职责 | 主路径 | In → Out |
|---------|------|--------|----------|
| workerHost | 子进程入口 | `pi-mono/inner-brain-worker.ts` | env → status.json |
| piMonoScheduler | tick 驱动 | `pi-mono/run-tick.ts` | — → `Controller.tick` |
| controllerFsm | **DyFlow 阶段状态机** | `inner-brain/controller.ts` | tick → mode 切换 |
| **designer** | **DyFlow DESIGN** 阶段（P0） | `inner-brain/designer.ts` | memory + last_failure + LocalNode index → local_dag.json |
| **runner** | **DyFlow RUN** 阶段（P0） | `inner-brain/runner.ts` | local_dag.json → 派发 baseNode/Creator |
| **baseNodeExecutor** | **baseNode（猛猛干 ReAct）**（P0） | `inner-brain/base-node-executor.ts` | LocalNode + instruction? + memory → outputs / failure_summary；**runtime context** §6.1b |
| **runtimeContext** | baseNode system 常驻环境块（P0） | `inner-brain/runtime-context.ts` | workDir + dataRoot → OS/shell/vault 契约 |
| **innerKeychainTools** | 内脑 vault 只读（P0） | `inner-brain/keychain-tools.ts` | `keychain_entries` / `keychain_get` |
| **toolOutputSpill** | 超大 tool 落盘 + 预览（P2） | `inner-brain/tool-output-spill.ts` | `.run/tool-output/*` |
| **reactMessagePrune** | ReAct 旧轮 prune（P2） | `inner-brain/react-message-prune.ts` | messages → 减 token |
| **shellStallGuard** | 重复 shell 失败检测（P2） | `inner-brain/shell-stall-guard.ts` | stall → transient failure |
| **nodeCreatorExecutor** | **newNodeCreator（pack/specialize）**（P0） | `inner-brain/node-creator-executor.ts` | params{mode,...} → 新 LocalNode + Abstractor 触发 |
| **localNodeStore** | **LocalNode 库**（P0） | `inner-brain/local-node-store.ts` | commit / read / list + index |
| **memoryStore** | **全局 memory.json**（P0） | `inner-brain/memory-store.ts` | patch/get goal/facts/constraints/last_failure/node_results |
| **designerToolRegistry** | **Designer 专用工具集**（P0） | `inner-brain/designer-tools.ts` | list_local_nodes / read_memory / search_and_instance / commit_local_dag / report_done |
| **presetSeeder** | **首次 spawn 注入 preset/***（P0） | `inner-brain/preset-seeder.ts` | workDir → preset/base + node_creator + extract_facts（TS 常量幂等 seed） |
| **memoryTools** | **record_fact / record_constraint**（P2） | `inner-brain/memory-tools.ts` | memoryStore → baseNode 注入工具（写回 facts/constraints 去重） |
| **workspaceScriptTools** | **T0 工具晋升：register_workspace_script_tool + materialize**（P0b） | `inner-brain/workspace-script-tools.ts` | workDir 脚本 → `ws_*` Tool（runner 注入 baseNode；Designer 可见清单） |
| **preset/extract_facts** | **环境事实提取节点**（P2，preset baseNode） | `inner-brain/preset-nodes.ts` | 探查环境 → record_fact 写 memory.facts |
| **nodeAbstractor** | **LocalNode → NodeDef（auto-export）**（P1） | `inner-brain/node-abstractor.ts` | LocalNode + envSnapshot → drive9 NodeDef |
| **nodeAssembler** | **NodeDef + binding → LocalNode**（P1） | `inner-brain/node-assembler.ts` | NodeDef + workDir + hints → imported LocalNode |
| brainFs | File-as-State（DyFlow 主用 memory/local_nodes；brainFs 余通用文件读写） | `brain/brain-fs.ts` | 读写 `.brain/*` |
| completionReport | burst DONE → 完成报告正文（im/verbose） | `openkuroneko/burst/completion-report.ts` | goal/milestones/deliverables → report |
| **workdirGuard** | **路径守卫 + peer 只读** | `tools/definitions/workdir-guard.ts` | path → allow/deny |
| **innerFileTools** | **read/search/write + peer 读** | `read-file-lines.ts`; `read-file.ts`; `peer-file-tools.ts` | 分页读 ✅ INNER-FILE-ACCESS |
| **shellProbe** | **批量 shell 探测** | `shell-probe.ts` | commands[] → 合并输出；早停 |
| **reactToolCallSlim** | **ReAct write/edit 参数瘦身** | `react-tool-call-slim.ts` | 落盘后省略 content 进 LLM 历史 |
| archiveStore | 归档 | `archive/fs-store.ts` | archive → session |

**视图**：`09-L3-Inner-Phases`（DyFlow Phases）；`09b-L3-Inner-DyFlow`（DyFlow 全模块图）；`14-L2-DyFlow-Node-Lifecycle`（NodeDef 共享/治理）。

阶段循环（与 [`DYFLOW-INNER-EXECUTOR.md`](./DYFLOW-INNER-EXECUTOR.md) §3 一致）：

```text
DESIGN → RUN → AWAITING → DONE
   ↑       │
   └───────┘  （RUN 完图 / terminal failure → DESIGN replan）
```

---

## L2 共享库

| 库 | path |
|----|------|
| chatIrLib | `packages/chat-ir` |
| **workspaceKit** | `packages/server/src/workspace-kit` — **外脑专用**（P3a 内联，原 `@utlra/core`）。内脑经 **file** 共享 `workDir`，不 import |
| webchatProtocolLib | `packages/webchat-protocol` |
| webchatBridge | `packages/webchat-bridge` — 出站 `asset:` → chat-server `/uploads` |

---

## 修订

| 日期 | 说明 |
|------|------|
| 2026-05-19 | 细粒度：participationPolicy + 内脑三阶段 + reflexion |
| 2026-05-19 | KPI 闭环接通：视图 `10-L2` / `10b` / `10c` + `KPI-CLOSED-LOOP.md` |
| 2026-05-20 | P2：`deps.rules.cjs` + `npm run structurizr:deps` |
| 2026-05-20 | P3c：`MEMORY-STORAGE-BOUNDARY.md` + repository/mem9/drive9 deps 规则 |
| 2026-05-29 | 资源感知 + 心跳自主调度：`RESOURCE-AWARENESS-AUTONOMY.md` + 视图 `11-L3-Outer-Autonomy` |
| 2026-05-29 | 分支选择简化为 KPI 优先 + `agentPersonality.idleChatProbability`；judge P0 仅 hard gates |
| 2026-06-01 | 环境模型 ADL：`ENVIRONMENT-MODEL.md` + 视图 `12-L3-Outer-Environment` + 三件套（sensorRegistry/journal/changeDetector） |
| 2026-06-01 | 战略规划层 ADL：`STRATEGY-PLANNING-LAYER.md` + 视图 `13-L3-Outer-Strategy` + 三件套（strategyStore/strategyPlanner/staleBurstReaper）；dispatcher 退化为按 strategy 派遣；解决历史 AWAITING 自动死 |
| 2026-06-02 | T0 工具晋升 `workspaceScriptTools`（[`DYFLOW-INNER-EXECUTOR.md`](./DYFLOW-INNER-EXECUTOR.md) §7b 固化三层 facts/LocalNode/Tool）|
| 2026-06-02 | DyFlow 内脑重构 ADL：[`DYFLOW-INNER-EXECUTOR.md`](./DYFLOW-INNER-EXECUTOR.md) + [`INNER-NODE-LIFECYCLE.md`](./INNER-NODE-LIFECYCLE.md)；新内脑模块 designer/runner/baseNodeExecutor/nodeCreatorExecutor/localNodeStore/memoryStore/designerToolRegistry/presetSeeder/nodeAbstractor/nodeAssembler；新外脑模块 nodeDefDrive9Store/nodeDefEviction；视图 `09b-L3-Inner-DyFlow` + `14-L2-DyFlow-Node-Lifecycle`；旧三件套（decomposer/executor/attributor/blockResolver）标 Deprecated-DyFlow；`INNER-EXECUTE-INCREMENTAL.md` 已 superseded |

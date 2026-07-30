# 模块视界目录（细粒度 · 与 workspace.dsl 同步）

> 对齐规则见 [`GRANULARITY.md`](./GRANULARITY.md)。**一模块 = 一事 + 可写清 In/Out**。  
> **名词**：一轮内脑执行 = **burst**（废弃文档中的 sprint 同义用法）— [`TERMINOLOGY.md`](./TERMINOLOGY.md)。

---

## L2 容器（进程 / 包）

见 `workspace.dsl` 中 `chatIrLib`、`agentServer`、`innerWorker` 等容器级 `horizon.*`。

**L1 约定（系统上下文）**：

- **用户**只经 **IM 接口**（`discord`、`feishu`、`localWebChatIm`）使用系统，**不**直连 `kuroneko` Agent API。
- **本地 IM** 在 L1 为 `localWebChatIm`，L2 由 `chatServer` + `webChat` 实现。
- **飞书** 在 L1 为 `feishu`，L2 由 `feishuBridge` + `channelConnectionRegistry`（N 连接/热插）实现；身份经 `identityBindingIndex.resolve`。见 [`IDENTITY-CROSS-CHANNEL.md`](./IDENTITY-CROSS-CHANNEL.md)。
- **内外脑监控** 在 L1 为 `brainMonitoring`，L2 由 `opsConsole` + `performanceDashboard` 实现；**运维/观察者** 与终端用户分离。

---

## L3 — 外脑模块（`agentServer` 进程）

| 模块 ID | 职责 | 主路径 | In → Out |
|---------|------|--------|----------|
| **participationPolicy** | **是否说话 / 是否回复** | `outer/inbound-policy.ts` + `participation-state.ts` | `OuterInboundMeta` → `shouldReply` / SPEAK·SILENT |
| outerBrainFacade | 外脑编排入口（IM + HTTP） | `outer/outer-brain.ts`; `outer/outer-http-inbound.ts` | `ChatIRInboundEvent` / `POST /api/outer/inbound` |
| structuredReplyParts | reply.v1 → MessagePart[] | `outer/structured-reply-parts.ts` | StructuredReply → parts |
| knowledgeRetrieval | 知识检索（含按人跨会话记忆注入） | `outer/knowledge-retrieval.ts` | query+senderSid → K/S/P + 本线程 + 跨线程 + 关于此人 片段 |
| **personMessageRecall** | **按人跨会话召回（chat-ir）**：sid 别名集（bindingIndex 派生）→ 其它 thread 近期发言 | `chat-ir/src/runtime/person-message-recall.ts` | store+sid → PersonMessageHit[]；见 IDENTITY-CROSS-CHANNEL §6.5 |
| threadOrchestrator | 线程串行 + mention 感知 freshCheck + FIFO 排队 | `outer/thread-orchestrator.ts`; `chat-ir/seen-tracker.ts` | thread ops |
| outerConversationLoop | 外脑多轮 LLM | `outer/outer-conversation-loop.ts` | context → tool_calls；结束后可跑 emptyPromiseReconcile |
| **emptyPromiseReconcile** | **空口承诺对账（post-loop）** | `outer/empty-promise-reconcile.ts` | 用户祈使 + 口头承诺 + 无成功派活 → 纠偏轮；见 IM-INBOUND-INTENT-ROUTING.md §4.2 |
| outerToolExecutor | 外脑工具执行 | `outer/outer-tools.ts` | tool_call → reply/spawn |
| **workspaceInbox** | **同 KPI peer 互读 + `.inbox/` 目录** | `outer/workspace-inbox.ts` | peer ids → catalog（名字/摘要） |
| innerBrainKpiReuse | set_goal 派发判定 | `outer/inner-brain-kpi-reuse.ts` | `isSetGoalDispatched`（canonical 复用已删，见 KPI-MANAGER-LAYER.md） |
| innerBrainRegistry | 内脑任务表 | `outer/inner-brain-registry.ts` | spawn/stop → TaskRecord；boot `markStaleRunningAsStopped`（**不** auto-resume，见 [`INNER-BRAIN-STARTUP-RESUME-REMOVED.md`](./INNER-BRAIN-STARTUP-RESUME-REMOVED.md)）；`remove` 供 retention |
| **innerWorkspaceRetention** | **终态 workspace 淘汰（心跳级）** | `outer/inner-workspace-retention.ts` | cold + quota → registry remove + rm workDir；见 [`INNER-WORKSPACE-RETENTION.md`](./INNER-WORKSPACE-RETENTION.md) |
| brainAsyncSnapshot | workDir 异步快照 | `outer/brain-async-snapshot.ts` | workDir → `is_post_complete` 等 |
| **innerBurstExit** | **burst onExit 最小辅助** | `outer/inner-burst-exit.ts` | workDir → `countDeliverables`；**已移除** hook/reconcile 见 [`KPI-BURST-LIFECYCLE-REMOVED.md`](./KPI-BURST-LIFECYCLE-REMOVED.md) |
| awaitingInboundResolver | **IM 回复解 pending** | `outer/awaiting-inbound-resolver.ts` | human IM → resolve → changeWatcher spawn；拒 agent-mirror/通知 echo |
| imNotifyDedup | **IM 通知去重** | `outer/im-notify-dedup.ts` | ledger `.run/im-notify-ledger.json`；24h fingerprint |
| awaitingNotify | **AWAITING 人类通知** | `outer/awaiting-notify.ts` | onExit AWAITING + ask_user → `⏸` IM（dedup） |
| innerSpawner | spawn 子进程 | `pi-mono/inner-brain-spawner.ts` | goal/workDir → child |
| kpiRegistry | KPI 与 burst 元数据 | `outer/kpi-registry.ts` | set_kpi → bursts / charter |
| **burstProcessReport** | **过程报告组装** | `outer/kpi/burst-process-report.ts` | tool-logs + memory.json + deliverables |
| **kpiCompletionJudge** | **KPI 完成判定（心跳 sweep）** | `outer/kpi-completion-judge.ts` | active KPI → achieved / digest |
| **nodeDefDrive9Store** | **drive9 `/nodes/shared/` 客户端（P1）** | `drive9/node-def-drive9-store.ts` | put/search/tombstone NodeDef + index；**search grep 空不回退全库**（INNER-NODE §4） |
| **nodeDefEviction** | **NodeDef 治理 sweep（P2，外脑心跳级）** | `outer/node-def-eviction.ts` | dedupe + quota + cold tombstone |
| outerMemory | mem9 记忆 | `outer/outer-memory.ts` | chat/task → mem9；Belief Card supersede 见 [`MEMORY-BELIEF-CARD.md`](./MEMORY-BELIEF-CARD.md) |
| **memoryBlockStore** | **结构化 Block CRUD** | `outer/memory-block-store.ts` + `memory-block-tools.ts` | `memory_block_*`；bind → `.brain/secrets/` |
| completionNotify | 完成通知（IM 精简） | `outer/completion-notify.ts` + `completion-report.ts` | DONE → ingest（`ingestInnerBrainDeliverablesOnExit`）+ 可选 IM；KPI 默认不 IM；`completion-notified.json` 去重 |
| pushLoop | 消费 worker 输出 | `outer/push-loop.ts` | PROGRESS 可选推渠道；**BLOCK 不推 IM**（见 IM-NOTIFY-BOUNDARY） |
| changeWatcher | AWAITING 唤醒 | `pi-mono/change-watcher.ts` | bootstrap + pendings 到期/解封 → **markConsumed** → spawn |
| llmGateway | LLM 调用 | `llm/` | messages → text/tools |
| **outerHeartbeat** | **数字员工 watchdog：质控 + 死亡/失约检测 + 漏事件 fallback** | `outer/outer-heartbeat.ts` | tick → sweep/reap/missed + `heartbeat_fallback`；非正常续派主时钟 |
| **digitalEmployeeLoop** | **✅ 容量驱动主循环：事件 coalesce → 日程优先 → 自主提案 → 唯一派发** | `outer/digital-employee-loop.ts` + `digital-employee-runtime.ts` | burst/calendar/dependency events → `set_goal` 或 sleep |
| **employeeCalendar** | **✅ 数字员工日程表（复用 Scheduler）；✅ 对话一等工具 list/schedule/cancel/pause（见 EMPLOYEE-CALENDAR）** | `scheduler/employee-calendar.ts` + `outer/calendar-tools.ts` + existing scheduler engine | once/interval/cron + due/missed → `calendar_due`；purpose: kpi_increment / chat_appointment / … |
| **selfWorkPolicy** | **✅ 可替换/可测试创造性：4 deterministic 策略 + llm_reflective + AbTest；✅ 推进经感知闸门（禁 Duty 整单重放）** | `outer/self-work-policy.ts` + `self-work-strategies.ts` + `self-work-llm-policy.ts` + `self-work-metrics.ts` | env/KPI/calendar/deps/history/blockedRoutes/perception → `SelfWorkProposal|null`；见 [`KPI-ADVANCE-WORK-PACKAGE.md`](./KPI-ADVANCE-WORK-PACKAGE.md) |
| **executableWorkflowStore** | **✅ Executable Workflow 注册表（版本化契约）** | `outer/executable-workflow-store.ts` | EW CRUD；见 [`EXECUTABLE-WORKFLOW.md`](./EXECUTABLE-WORKFLOW.md) |
| **workflowPromote** | **✅ 探索产物 → 冻结 EW（须 expect）** | `outer/workflow-promote.ts` | workspace 产物 → `ExecutableWorkflow@version` |
| **burstModeGate** | **✅ set_goal / Designer 按 explore\|execute 收权** | `outer/burst-mode-gate.ts` + `set_goal` + designer | execute 缺 `workflowRef` 拒收；禁 redesign |
| **advanceWorkPackageBuilder** | **✅ 推进调配：感知面（日历+内脑+stall+cursor）+ 简单规则 + P3 指标** | `outer/advance-perception.ts` + `advance-allocator.ts` + `advance-cursor-store.ts` + `advance-metrics.ts` | 读 facet → execute_due / set_goal / ensure_calendar / repair / sleep；见 [`KPI-ADVANCE-WORK-PACKAGE.md`](./KPI-ADVANCE-WORK-PACKAGE.md) |
| **llmUsageTracker** | **LLM token/并发计量** | `outer/llm-usage-tracker.ts` | completion → 滚动 usage + journal |
| **llmUsageJournal** | **Token 统计持久化** | `outer/llm-usage-journal.ts` | entry → `usage/llm-usage.jsonl` + summary API |
| **resourceProbe** | **资源感知快照（P0；已由 environmentSensorRegistry 在 pipeline 经 toResourceSnapshot 适配接管，行为等价）** | `outer/resource-probe.ts` | registry/tracker → ResourceSnapshot |
| **environmentSensorRegistry** | **环境模型 — 传感器注册表（✅ P0；collect 扇入 + cadence + 派生注入）** | `outer/environment/sensor-registry.ts` | sensors[].read → EnvironmentSnapshot |
| **environmentJournal** | **环境模型 — 时序日志（✅ ring + current.json + events.jsonl 月轮转 + hourly + 未消费查询/markConsumed）** | `outer/environment/journal.ts` | snapshot/events → 三层留存 + 未消费查询 |
| **environmentChangeDetector** | **环境模型 — 派生指标 + 事件检测（✅ hysteresis/warmUp/rate·delta·streak）** | `outer/environment/change-detector.ts` | prev/next → derived + events |
| **environmentModelFacade** | **环境模型 — facade（collectEnvironmentSnapshot / toResourceSnapshot 适配 / getSharedEnvironment）** | `outer/environment/index.ts` | deps → EnvironmentSnapshot ↔ ResourceSnapshot |
| **kpiSpawnCapacity** | **执行容量（兼容名）：读 facets + hardGates；✅ P3 自适应前台预留（前台活跃扣 `foregroundReserveSlots`，高压 inbound_pressure 全停）** | `outer/environment/kpi-spawn-capacity.ts` | EnvironmentSnapshot + policy → `hasAvailableCapacity` / canSpawn |
| **autonomyPolicyStore** | **闲忙规则（可聊天改）；DE-4：schema 无 KPI 时间配额（kpi_inner_goal 仅 enabled；hardGates 无 minMsSinceLast），旧字段 load 时删除回写** | `outer/environment/autonomy-policy-store.ts` | policy.json + rubric.md；casual_chat 频控保留 |
| **autonomyJudge** | **容量判定（hard gates）** | `outer/environment/autonomy-judge.ts` | snapshot+policy → hasAvailableCapacity（兼容 idle/busy） |
| **agentPersonality** | **性格参数（闲聊概率）** | `outer/personality.ts` | personality.json → idleChatProbability |
| **casualChatDispatcher** | **idle proactive IM 闲聊（KPI 找活由 digitalEmployeeLoop / SelfWorkPolicy）** | `outer/casual-chat-dispatcher.ts` | capacity + personality → post_to_im |
| **identityLinkService** | **跨渠道同人双边确认（Agent 不裁决）** | `outer/identity-link-service.ts` | request/confirm → linkMerge；[`IDENTITY-CROSS-CHANNEL.md`](./IDENTITY-CROSS-CHANNEL.md) |
| **channelConnectionRegistry** | **IM 多连接 + 飞书热插** | `outer/channel-connection-registry.ts` | connections.json + keychain；N 条 feishu（connector 已注册） |
| **qrTools** | **URL/文本 → 二维码 PNG 发当前 thread** | `outer/qr-tools.ts` | `qr_generate` 工具；`generateQrPng` 供扫码流（P4a/P4b）附图复用 |
| **visionTools** | **外脑识图（聊天图片 attachment → 文字描述）** | `outer/vision-tools.ts` | `view_image` 工具；asset → 临时文件 → 复用内脑 `describeImageFile`（智谱 Vision MCP） |
| **imIntentClassifier** | **入站意图（默认 chat / followup / ad-hoc / kpi_update / kpi_create-ongoing）** | `outer/inbound/im-intent-classifier.ts` | IM 文本 + 上下文 → intent；见 IM-INBOUND-INTENT-ROUTING.md |
| **subKpiDecomposer** | **【已删除】扁平 KPI** | — | 见 KPI-MANAGER-LAYER.md §2.1 |
| **kpiBurstState** | **多 burst 资格 + 并行上限 + R7 连败/路线分析** | `outer/kpi/kpi-burst-state.ts` | R1/R2；`maxParallelBurstsPerKpi`；`countConsecutiveBurstFailures` + `analyzeConsecutiveFailureRoutes` |
| **kpiFailureCircuit** | **✅ R7 路线级熔断（P2）** | `outer/kpi/kpi-failure-circuit.ts` | 单路线连败 → blockedRoutes（KPI 保持 active）；多路线/无 goal → pause + IM |
| **kpiAwaitingReview** | **AWAITING 审查 R3/R4** | `outer/kpi/kpi-awaiting-review.ts` | 不合理等待收口；合法等待释放员工容量 |
| **kpiCadence** | **【已删除】** 不复活；业务定时归 `employeeCalendar` | — | 见 DIGITAL-EMPLOYEE-AUTONOMY.md §3 |
| **kpiSlotIdle** | **ongoing 槽位判定（⏳ DONE/AWAITING=空闲）** | `outer/kpi/kpi-slot-idle.ts` | leaf KPI + registry + snapshot → idle? |
| **burstReuse** | **【已删除】每次 advance 新 workspace** | — | 见 KPI-MANAGER-LAYER.md §2.2 |
| **burstRunHistory** | **Burst 执行史（⏳ 外脑读 run digest）** | `outer/kpi/burst-run-history.ts` | onExit → BurstRunRecord[] |
| **kpiManager** | **KPI 治理（✅ R3–R7/reap；数字员工模式下 heartbeat governance-only）** | `outer/kpi/kpi-manager.ts` | KPI/burst truth → stop/reap/pause/complete；非 runtime 兼容 advance |
| **kpiAdvancer** | **KPI burst 执行（IM/Ops/`advance_kpi`；心跳由 kpiManager 调）** | `outer/kpi/kpi-advancer.ts` | advanceKpi → set_goal |
| **adHocBurstAllocator** | **一次性任务 burst（✅ 无 kpi_id）** | `outer/ad-hoc-burst-allocator.ts` | ad_hoc goal → new instance |
| **inboundContextAssembler** | **IM 入站只读上下文装配（方案一：前置不派发）** | `outer/inbound/inbound-kpi-router.ts` | assembleInboundContext + renderInboundHint → inboundHint 注入对话环；派发交 set_goal/set_kpi/advance_kpi/send_directive 工具；见 IM-INBOUND-INTENT-ROUTING.md §4 |
| **agentStatusChatCommand** | **聊天只读快指令：当前进度 + 过去 24h 任务密度（无 LLM / 无 brain-inspector）** | `outer/inbound/agent-status-chat-command.ts` + `outer/agent-activity-snapshot.ts` | `状态/进度` → live snapshot；`密度/今天` → slot-time utilization / completion / failure / KPI activity |
| **strategyPlanner** | **【已删除】** | — | 见 DIGITAL-EMPLOYEE-AUTONOMY.md（SelfWorkPolicy） |
| **strategyStore** | **【已删除】** | — | 见 KPI-MANAGER-LAYER.md |
| **staleBurstReaper** | **僵尸清理（kpiManager R5）** | `outer/kpi/stale-burst-reaper.ts` | selectStaleAwaiting + reap → ABORTED |
| **kpiAwaitingReviewLlm** | **AWAITING LLM 复审（P3）** | `outer/kpi/kpi-awaiting-review-llm.ts` | requireProgressSignal 后 optional LLM |
| **kpiFeedback** | **多巴胺反馈调节（momentum 增量 + 选 KPI）** | `outer/kpi-feedback.ts` | BurstFeedbackSignal → Δmomentum / selectKpiByMomentum |
| performanceGoalEngine | **已废弃侧车**（绩效目标 = KPI）；保留代码/存储，不接入数字员工环 | `performance-goals/engine.ts` | 见 [`KPI-MANAGER-LAYER.md`](./KPI-MANAGER-LAYER.md) §2.4 |

**视图**（Structurizr，按路径拆开避免一张图过密）：

| 视图 | 内容 |
|------|------|
| `06-L3-Outer-AllModules` | 全部外脑组件 + 所有 L3 边 |
| `07-L3-Outer-Inbound-IM` | IM 入站：Facade → **awaitingInboundResolver** → 检索/记忆/是否说话 → 对话环 → 工具 |
| `07b-L3-Outer-Inbound-HTTP` | HTTP 入站：Facade（与 IM 同路径）→ policy → conversationLoop |
| `08-L3-Outer-Inner-Lifecycle` | spawn、registry markStale、changeWatcher、pushLoop、completionNotify、innerBurstExit、KPI |
| `10-L2-KPI-Closed-Loop` | L2：agentServer ↔ innerWorker |
| `10b-L3-Outer-KPI` / `10c-L3-Inner-Reflexion` | L3 外脑调度 / 内脑反思分图 |
| **`11-L3-Outer-Autonomy`** | **数字员工自主工作总览：容量 + Calendar + SelfWorkPolicy；heartbeat watchdog** |
| **`14-L3-Digital-Employee-Loop`** | **数字员工主循环：事件触发 → 容量 → Calendar / SelfWorkPolicy → set_goal；heartbeat watchdog** |
| **`12-L3-Outer-Environment`** | **环境模型：sensor registry / journal / change detector / 消费方** |
| **`13-L3-Outer-Strategy`** | **【历史视图名】** 战略层已删除；现行见 `14-L3-Digital-Employee-Loop` |

**KPI 闭环**（实现与 ADL）：见 [`KPI-CLOSED-LOOP.md`](./KPI-CLOSED-LOOP.md)。

**KPI 完成判定**：见 [`KPI-COMPLETION-JUDGE.md`](./KPI-COMPLETION-JUDGE.md)。  
**心跳内脑质控**（验收效果 + 卡死/restart 把控）：见 [`OUTER-HEARTBEAT-OVERSIGHT.md`](./OUTER-HEARTBEAT-OVERSIGHT.md)。  
**资源感知与心跳自主调度**（P0 历史 ADL，勿按文实现；现行为 [`DIGITAL-EMPLOYEE-AUTONOMY.md`](./DIGITAL-EMPLOYEE-AUTONOMY.md)）：见 [`RESOURCE-AWARENESS-AUTONOMY.md`](./RESOURCE-AWARENESS-AUTONOMY.md)。  
**环境模型**（P1 起替代 resourceProbe）：见 [`ENVIRONMENT-MODEL.md`](./ENVIRONMENT-MODEL.md)。  
**战略规划层**（P1 心跳重构）：见 [`STRATEGY-PLANNING-LAYER.md`](./STRATEGY-PLANNING-LAYER.md)。

**外脑重启恢复内脑**（实现与 ADL）：见 [`INNER-BRAIN-RESUME.md`](./INNER-BRAIN-RESUME.md)。

**AWAITING 生命周期**：[`INNER-BRAIN-AWAITING-LIFECYCLE.md`](./INNER-BRAIN-AWAITING-LIFECYCLE.md)。  
**内脑上游 Inbox**：[`INNER-WORKSPACE-INBOX.md`](./INNER-WORKSPACE-INBOX.md)。  
**内脑文件访问（大文件）**：[`INNER-FILE-ACCESS.md`](./INNER-FILE-ACCESS.md)。  
**Memory Block**：[`MEMORY-BLOCKS.md`](./MEMORY-BLOCKS.md)。

**记忆/知识边界**（P3c）：见 [`MEMORY-STORAGE-BOUNDARY.md`](./MEMORY-STORAGE-BOUNDARY.md)。

**测试**（按 component）：[`COMPONENT-TESTING.md`](./COMPONENT-TESTING.md) · 清单 [`COMPONENT-TEST-MAP.md`](./COMPONENT-TEST-MAP.md)

**单入口**：生产 IM 与 HTTP 调试均走 `outerBrainFacade`（`POST /api/outer/inbound`）。

---

## L3 — 内脑模块（`innerWorker` 子进程）

> **DyFlow 单引擎**：旧三件套 `decomposer / executor / attributor / blockResolver` 及 `reflexion` 已删除（不再有 `INNER_BRAIN_ENGINE` 切换）。详见 [`DYFLOW-INNER-EXECUTOR.md`](./DYFLOW-INNER-EXECUTOR.md)、[`INNER-NODE-LIFECYCLE.md`](./INNER-NODE-LIFECYCLE.md)。

| 模块 ID | 职责 | 主路径 | In → Out |
|---------|------|--------|----------|
| workerHost | 子进程入口 | `pi-mono/inner-brain-worker.ts` | env → status.json |
| piMonoScheduler | tick 驱动 | `pi-mono/run-tick.ts` | — → `Controller.tick` |
| controllerFsm | **DyFlow 阶段状态机** | `inner-brain/controller.ts` | tick → DESIGN/RUN/ATTRIBUTE/… 切换 |
| dyflowAttributor | **RUN 后强制归因** | `inner-brain/attributor.ts` | run-context → memory.facts/constraints |
| **designer** | **DyFlow DESIGN** 阶段（P0） | `inner-brain/designer.ts` | memory + last_failure + LocalNode index → local_dag.json |
| **runner** | **DyFlow RUN** 阶段（P0） | `inner-brain/runner.ts` | local_dag.json → 派发 baseNode/Creator |
| **baseNodeExecutor** | **baseNode（猛猛干 ReAct）**（P0） | `inner-brain/base-node-executor.ts` | LocalNode + instruction? + memory → outputs / failure_summary；**runtime context** §6.1b；**§6.7 验票**；**§6.7a P-prompt** 注入 deliverable |
| **nodeAcceptance** | **完成验票 + shell-evidence**（P0b） | `inner-brain/node-acceptance.ts` | executionLog + outputs → ok/failed；shell 404 假成功；P-evidence；集成 NodeInst.deliverable |
| **deliverableCheck** | **节点级交付物机械验票引擎**（DYFLOW §6.7a/§9a） | `inner-brain/deliverable-check.ts` | file/json_key/stdout_*；P-alias 路径别名；被 nodeAcceptance + report_done 复用 |
| **failureDistill** | **RUN 失败→constraints**（P0b） | `inner-brain/failure-distill.ts` | controller RUN 后 mandatory 红线蒸馏 |
| **runtimeContext** | baseNode system 常驻环境块（P0） | `inner-brain/runtime-context.ts` | workDir + dataRoot → OS/shell/vault 契约 |
| **innerKeychainTools** | 内脑 vault 只读（P0） | `inner-brain/keychain-tools.ts` | `keychain_entries` / `keychain_get` |
| **toolOutputSpill** | 超大 tool 落盘 + 预览（P2） | `inner-brain/tool-output-spill.ts` | `.run/tool-output/*` |
| **reactMessagePrune** | ReAct 旧轮 prune（P2） | `inner-brain/react-message-prune.ts` | messages → 减 token |
| **shellStallGuard** | 重复 shell 失败检测（P2） | `inner-brain/shell-stall-guard.ts` | stall → transient failure |
| **burstStallEvaluator** | **burst 级空转判定** | `inner-brain/burst-stall-evaluator.ts` | memory/node_results → verdict |
| **burstStallAlert** | **空转告警落盘 + 索引** | `inner-brain/burst-stall-alert.ts` | verdict → `stall-alerts/` 包 + `index.jsonl` |
| **localNodeStore** | **LocalNode 库**（P0） | `inner-brain/local-node-store.ts` | commit / read / list + index |
| **memoryStore** | **全局 memory.json**（P0） | `inner-brain/memory-store.ts` | patch/get goal/facts/constraints/last_failure/node_results/dag_history(环形)/locked_milestones |
| **factTopic** | **事实 topic 归一化** | `inner-brain/fact-topic.ts` | content → merge key；含 `fanqie.publish.*` |
| **factGovernor** | **事实合并/淘汰/注入上限** | `inner-brain/fact-governor.ts` | supersede-on-write · quota/cold · prompt select · conflict sweep |
| **factConflict** | **事实矛盾启发式** | `inner-brain/fact-conflict.ts` | polarity · stale status · `fact_conflicts[]` |
| **drive9KnowledgeShared** | **drive9 `/knowledge/shared/` 完全共享读写** | `outer/knowledge-promote.ts` · `drive9/knowledge-drive9-store.ts` | `createDrive9FactSyncSink` / `seedDrive9FactsToMemory`；ADL [`DRIVE9-KNOWLEDGE-SHARED.md`](./DRIVE9-KNOWLEDGE-SHARED.md) |
| **factDrive9Eviction** | **drive9 共享事实淘汰**（⏳ P2） | `outer/fact-drive9-eviction.ts` | 对齐 nodeDefEviction |
| **designerToolRegistry** | **Designer 专用工具集**（P0） | `inner-brain/designer-tools.ts` | list_local_nodes / read_memory / search_and_instance / commit_local_dag(拦截已锁里程碑) / report_done(verify 闸门) / promote_local_node(成功提升 fire-and-forget auto-export) / lock_milestone |
| **presetSeeder** | **首次 spawn 注入 preset/***（P0） | `inner-brain/preset-seeder.ts` | workDir → preset/base + node_creator + extract_facts（TS 常量幂等 seed） |
| **memoryTools** | **record_fact / record_constraint**（P2） | `inner-brain/memory-tools.ts` | memoryStore → baseNode 注入工具（写回 facts/constraints 去重） |
| **preset/extract_facts** | **环境事实提取节点**（P2，preset baseNode） | `inner-brain/preset-nodes.ts` | 探查环境 → record_fact 写 memory.facts |
| **nodeAbstractor** | **LocalNode → NodeDef（auto-export）**（P1） | `inner-brain/node-abstractor.ts` | LocalNode + envSnapshot + skills → drive9 NodeDef |
| **nodeSkillStore** | **节点绑定技能读写**（P1） | `inner-brain/node-skill-store.ts` | `.brain/local_nodes/skills/` |
| **nodeSkillLoader** | **baseNode 执行前加载技能**（P1） | `inner-brain/node-skill-loader.ts` | 绑定技能 + 全局检索 → prompt |
| **nodeSkillTools** | **Attributor record_skill**（P1） | `inner-brain/node-skill-tools.ts` | RUN 后蒸馏操作步骤；可晋升为 EW kind=`skill_md` |
| **workflowRunner** | **✅ execute 模式逐步执行 EW（async；可注入 browser/frozen）** | `inner-brain/workflow-runner.ts` | assert/shell/skill_step/browser_steps/run_node |
| **workflowKindAdapters** | **✅ browser_playbook / frozen_dag 适配（P3–P4 真跑）** | `inner-brain/workflow-adapters.ts` + `workflow-frozen-live.ts` | dry-run 落盘；execute 默认真跑 |
| **workflowTools** | **✅ 外脑 workflow_list/get/promote/run/pause** | `outer/workflow-tools.ts` | 见 [`EXECUTABLE-WORKFLOW.md`](./EXECUTABLE-WORKFLOW.md) §10 |
| **workflowDrive9Store** | **✅ drive9 `/workflows/shared/`** | `drive9/workflow-drive9-store.ts` | promote 同步；跨 agent 共享 |
| **workflowDrive9Seed** | **✅ boot/miss pull → 本地 put** | `drive9/workflow-drive9-seed.ts` | P3 |
| **workflowForKpi** | **✅ KPI tag → EW 匹配；SelfWork 优先 execute** | `outer/workflow-for-kpi.ts` | tag `kpi:{kpiId}` |
| **workflowsRoute** | **✅ Dashboard 只读 list/get** | `api/workflows-route.ts` | `GET /api/workflows` |
| **workflowFailureCircuit** | **✅ execute 连败 pause EW** | `outer/workflow-failure-circuit.ts` | 心跳 tick；不 pause KPI |
| **workflowPromoteSuggest** | **✅ promote 建议（外脑只读）** | `outer/workflow-promote-suggest.ts` | `workflow_suggest_promote` |
| **workflowOutcomeEvaluator** | **✅ EW execute 质检（W15）** | `outer/workflow-outcome-evaluator.ts` | settle → needsEvolution |
| **workflowEvolutionStore** | **✅ EW 修订提案** | `outer/workflow-evolution-store.ts` | `autonomy/workflow-evolution.json` |
| **workflowEvolutionPolicy** | **✅ 自优化提案 + SelfWork 优先** | `outer/workflow-evolution-policy.ts` | `purpose=ew_revision` 穿透日历闸 |
| **promoteExecutableWorkflow** | **✅ ATTRIBUTE 层 C 晋升（主路径）** | `inner-brain/promote-executable-workflow-tool.ts` | Attributor 工具 |
| **nodeAssembler** | **NodeDef + binding → LocalNode**（P1） | `inner-brain/node-assembler.ts` | NodeDef + workDir + hints → imported LocalNode |
| brainFs | File-as-State（DyFlow 主用 memory/local_nodes；brainFs 余通用文件读写） | `brain/brain-fs.ts` | 读写 `.brain/*` |
| completionReport | burst DONE → 完成报告正文（im/verbose） | `openkuroneko/burst/completion-report.ts` | goal/milestones/deliverables → report |
| **workdirGuard** | **路径守卫 + peer 只读** | `tools/definitions/workdir-guard.ts` | path → allow/deny |
| **innerFileTools** | **read/search/write + peer 读** | `read-file-lines.ts`; `read-file.ts`; `peer-file-tools.ts` | 分页读 ✅ INNER-FILE-ACCESS |
| **describeImageTool** | **栅格图识图** | `describe-image.ts` | `describe_image` → visionModel；✅ INNER-VISION-TOOL |
| **shellProbe** | **批量 shell 探测** | `shell-probe.ts` | commands[] → 合并输出；早停 |
| **browserSessionRegistry** | **Playwright 增量会话** | `browser/session-registry.ts` | open/act/close；node 结束自动清理；✅ BROWSER-SESSION-TOOL |
| **browserTools** | **browser_open/act/close/list/run_steps** | `browser-tools.ts` | UI 自动化；snapshot 落盘；playbook 脚本 |
| **browserPlaybook** | **步骤脚本解析** | `browser/browser-playbook.ts` | 内联 steps / playbook JSON |
| **reactToolCallSlim** | **ReAct write/edit 参数瘦身** | `react-tool-call-slim.ts` | 保护窗口外旧轮 `__SLIM_REF__`；最近 N 轮保留全文 |
| **writeContentGuard** | **write_file 占位符拒绝 + 同路径保护** | `write-content-guard.ts` + `base-node-executor.ts` | 禁止 `[N chars omitted…]` / `__SLIM_REF__` 落盘；节点内二次 overwrite 拒绝 |
| archiveStore | 归档 | `archive/fs-store.ts` | archive → session |
| **planReferenceSearch** | Designer 方案参考检索 | `outer/plan-reference-search.ts` · `inner-brain/plan-reference-port.ts` | `search_task_plans` → archive/repo/peer |

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
| chatIrLib | `packages/chat-ir`（含 **identityBindingIndex**，见 IDENTITY-CROSS-CHANNEL） |
| **workspaceKit** | `packages/server/src/workspace-kit` — **外脑专用**（P3a 内联，原 `@utlra/core`）。内脑经 **file** 共享 `workDir`，不 import |
| webchatProtocolLib | `packages/webchat-protocol` |
| webchatBridge | `packages/webchat-bridge` — 出站 `asset:` → chat-server `/uploads` |
| **feishuBridge** | `packages/feishu-bridge` — 多连接（thread_id 编入 app_id）；入站 resolve（union_id + scope=app_id）；Typing=reaction；长连接 SDK 可选依赖；P4a `scan-register`（registerApp device flow） |
| **wechatBridge** | `packages/wechat-bridge` — 微信 iLink ClawBot（扫码登录 bot_token / getupdates 长轮询 / context_token 出站锚点 / sendtyping）；媒体收发经 CDN AES-128-ECB（入站镜像落 asset store，出站附件真发图/文件）；一号一连接，基本仅私聊；见 IDENTITY-CROSS-CHANNEL §6.6 |

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
| 2026-06-06 | 环境模型 P0 落地：`outer/environment/` 五模块 + facade；6 内置 sensor；pipeline 经 toResourceSnapshot 行为等价接管 resourceProbe；3 套单测全绿 |
| 2026-06-01 | 战略规划层 ADL：`STRATEGY-PLANNING-LAYER.md` + 视图 `13-L3-Outer-Strategy` + 三件套（strategyStore/strategyPlanner/staleBurstReaper）；dispatcher 退化为按 strategy 派遣；解决历史 AWAITING 自动死 |
| 2026-06-06 | 战略规划层 P0 落地：`outer/strategy/` 七模块（store/trigger/artifact/planner/dispatch/reaper/facade）；planner 注入 callLlm + reject→fallback；reaper 静态超时兜底 + ABORTED 状态迁移（TaskStatus 加 ABORTED）；6 套单测 43 例全绿；`runStrategyPhase` 默认关（UTLRA_STRATEGY_LAYER_ENABLED） |
| 2026-06-06 | 战略层接 live 心跳（gated 默认关）：+`strategyLiveAdapter`；`autonomyPipeline` idle 时跑 `runLiveStrategyPhase`，dispatcher `pickActiveKpi` 按 focusOrder∩active 选 + `strategyMode` 跳闲聊；flag 关时零行为差；strategy 套 52 例全绿 |
| 2026-06-02 | ~~T0 工具晋升 `workspaceScriptTools`~~（已于 2026-06-06 移除，见下行） |
| 2026-06-06 | **移除 T0 工具晋升** `workspaceScriptTools` / `register_workspace_script_tool` / `ws_*`（[`DYFLOW-INNER-EXECUTOR.md`](./DYFLOW-INNER-EXECUTOR.md) §7b 固化收成两层 facts/LocalNode；生产零调用）|
| 2026-06-02 | DyFlow 内脑重构 ADL：[`DYFLOW-INNER-EXECUTOR.md`](./DYFLOW-INNER-EXECUTOR.md) + [`INNER-NODE-LIFECYCLE.md`](./INNER-NODE-LIFECYCLE.md)；新内脑模块 designer/runner/baseNodeExecutor/nodeCreatorExecutor/localNodeStore/memoryStore/designerToolRegistry/presetSeeder/nodeAbstractor/nodeAssembler；新外脑模块 nodeDefDrive9Store/nodeDefEviction；视图 `09b-L3-Inner-DyFlow` + `14-L2-DyFlow-Node-Lifecycle`；旧三件套（decomposer/executor/attributor/blockResolver）标 Deprecated-DyFlow；`INNER-EXECUTE-INCREMENTAL.md` 已 superseded |
| 2026-07-16 | 跨渠道身份认同 ADL：[`IDENTITY-CROSS-CHANNEL.md`](./IDENTITY-CROSS-CHANNEL.md)；模块 `identityLinkService` / `channelConnectionRegistry`；库侧 `identityBindingIndex`；L2 `feishu` + `feishuBridge`（⏳）；视图 `03b` / `07c` |
| 2026-07-17 | P2b：`feishuBridge`（`packages/feishu-bridge`）落地并注册 connector（kind=feishu）；飞书路径 ⏳ 全部转 ✅ |
| 2026-07-21 | P4a+P4b：飞书扫码建应用（`scan-register` + `feishu_channel_scan_add`）；微信 iLink 桥 `wechatBridge`（kind=wechat connector + `wechat_channel_add`）；L2 新增 `wechat` 外部系统与 `03c` 视图 |
| 2026-07-21 | `qrTools`（`outer/qr-tools.ts`）：`qr_generate` 工具 + 扫码流（P4a/P4b）URL 消息自动附二维码 PNG（asset attachment，webchat 内联显示） |
| 2026-07-21 | P4b-media：`wechatBridge` 媒体收发（CDN AES-128-ECB；入站镜像 → asset store；出站附件真发图/文件，失败降级防链接化文本）；typing 修复（`ilink_user_id` + status=2） |
| 2026-07-21 | `visionTools`（`outer/view_image`）：外脑识图接通——聊天图片 asset → 内脑 `describeImageFile` 管线；`sendFileMessage` 修复（`md5` + `len` 字符串，解 `invalid request`） |
| 2026-07-21 | 数字员工自主工作 ADL：新增 `digitalEmployeeLoop` / `employeeCalendar` / `selfWorkPolicy`（⏳）；复用 Scheduler；等待只阻塞依赖，heartbeat 降为 watchdog。 |
| 2026-07-21 | 数字员工 P0/P1 落地：loop/runtime + Scheduler Calendar adapter + burst/calendar/dependency/heartbeat 接线；SelfWorkPolicy conservative/校验落地，P2/P3 余项保留 🟡。 |
| 2026-07-21 | 数字员工 P2 落地：`self-work-strategies`（4 策略角度轮询）+ `self-work-metrics`（acceptance/duplicate/no-progress/byStrategy JSONL）；R7 下沉路线级（`kpi_route_circuit` 不 pause KPI）；burst onExit 统一写 `burstRunHistory`。 |
| 2026-07-21 | 数字员工 P3 落地：`self-work-llm-policy`（llm_reflective + deterministic fallback）；`AbTestSelfWorkPolicy`（探索满 minTrials 后按 acceptance rate 利用）；`hasAvailableCapacity` 自适应前台预留（`foregroundReserveSlots`，前台对话不再全停）。 |
| 2026-07-22 | 产物管道缺口落地：[`DELIVERABLE-PIPELINE-GAPS.md`](./DELIVERABLE-PIPELINE-GAPS.md)；`ingestInnerBrainDeliverablesOnExit`；deliverableCheck P-alias / P-rel / P-clear / P-evidence |
| 2026-07-22 | 「推进」工作包 ADL：[`KPI-ADVANCE-WORK-PACKAGE.md`](./KPI-ADVANCE-WORK-PACKAGE.md)；模块 `advanceWorkPackageBuilder` ✅ P0/P1 |
| 2026-07-23 | 确定性工作流 ADL：[`EXECUTABLE-WORKFLOW.md`](./EXECUTABLE-WORKFLOW.md)；Executable Workflow ⊃ Skills；`burstMode` explore\|execute |
| 2026-07-23 | EW P0+P0.1 落地：store/promote/gate/runner/adapters + 外脑 `workflow_*` 工具（25 单测） |
| 2026-07-23 | EW P1：drive9 `/workflows/shared/` + SelfWork `workflowRef` → execute（46 相关单测） |
| 2026-07-23 | EW P2：failure circuit + promote suggest + kpi_sequence |
| 2026-07-24 | EW promote W5–W10：action/args 闸门 + 路径可移植 + 步间落盘 + pause 非法契约 |
| 2026-07-24 | EW W11–W12：secretRefs/keychain 注入 + KPI `role:*` 挑选（X 监控为主验证场景） |
| 2026-07-24 | EW W13：assets 脚本打包 + args.secretRefs hoist |
| 2026-07-24 | EW W14：async shell + 外脑 EW 后台执行（防堵死对话） |
| 2026-07-24 | Dashboard 内脑 burst 执行 graph：inspector edges/status + EW workflow_run |
| 2026-07-25 | Dashboard 主 Tab 精简：Burst/EW/用量/空转/日志/记忆块；旧面进高级 |
| 2026-07-28 | 内脑 workspace 保留：[`INNER-WORKSPACE-RETENTION.md`](./INNER-WORKSPACE-RETENTION.md)；`innerWorkspaceRetention` + `read_inner_status` historyCap |

# Structurizr L3 组件 ↔ 测试用例对照表

> **原则**：每个 ADL `component` 一行；测试按 [`COMPONENT-TESTING.md`](./COMPONENT-TESTING.md) 命名（`*.component.integration.test.ts` 等）。  
> 汇总统计仍见 [`doc/testing-strategy.md`](../testing-strategy.md) §4。

## 设计原则（与 ADL 一致）

| 层级 | 测什么 | 文件后缀 |
|------|--------|----------|
| **单元** | 纯函数 / 解析 / 策略（`horizon.in` 的可测子集） | `*.test.ts` |
| **模块（黑盒）** | 单一职责的 In→Out 契约，临时 workDir / FakeLLM | `*.component.integration.test.ts` |
| **Prompt 效果** | 真实 LLM + prompt 输出形态 | `*.prompt.test.ts` |
| **装配** | `index` 启停、假入站→假出站 | 最后做（§4.4） |

红线见 testing-strategy §8：单测不跨模块 import；**不以 Structurizr 组件名为文件名**，而以**可测入口函数**命名（组件测文件例外：`*.<moduleId>.component.integration.test.ts`）。

## 外脑 L3（`agentServer`）

| ADL 模块 ID | 单元测 | 模块测 | Prompt 测 | 备注 |
|-------------|--------|--------|-----------|------|
| participationPolicy | ✅ `inbound-policy.test.ts` | ✅ `participationPolicy.component.integration.test.ts` | ✅ `inbound-policy.prompt.test.ts` | 样板组件 |
| outerBrainFacade | 🟡 片段 | ✅ `outerBrainFacade.component.integration.test.ts` | — | + `integration/outer-brain-inbound` 全链 |
| knowledgeRetrieval | ❌ | ✅ `knowledgeRetrieval.component.integration.test.ts`（含 P3 按人跨会话块） | — | |
| threadOrchestrator | ✅ `chat-ir/seen-tracker.test.ts`（freshCheck @ 语义） | ✅ `threadOrchestrator.component.integration.test.ts`（串行 + FIFO 排队） | — | freshCheck 实现于 `@utlra/chat-ir` |
| outerConversationLoop | ❌ | ✅ `outerConversationLoop.component.integration.test.ts` | — | + `integration/outer-conversation-loop-assembly` |
| outerToolExecutor | 🟡 tools 单测散落 | ✅ `outerToolExecutor.component.integration.test.ts` | — | `normalizeAgentReplyMentionText` |
| **workspaceInbox** | ✅ `workspace-inbox.test.ts` | ⏳ | — | ADL [`INNER-WORKSPACE-INBOX.md`](./INNER-WORKSPACE-INBOX.md) |
| **innerFileTools** | ✅ `read-file-lines.test.ts` | — | — | ADL [`INNER-FILE-ACCESS.md`](./INNER-FILE-ACCESS.md) |
| **describeImageTool** | ✅ `describe-image.test.ts` | — | — | ADL [`INNER-VISION-TOOL.md`](./INNER-VISION-TOOL.md) |
| **shellProbe** | ✅ `shell-probe.test.ts` | — | — | ADL [`DYFLOW-INNER-EXECUTOR.md`](./DYFLOW-INNER-EXECUTOR.md) §6.6 |
| **browserSessionRegistry** | ✅ `session-registry.test.ts` | — | — | ADL [`BROWSER-SESSION-TOOL.md`](./BROWSER-SESSION-TOOL.md) |
| **browserTools** | ✅ `browser-tools.test.ts` | — | — | P0 goto/click/snapshot；P1 run_steps + playbook + from_step |
| **browserPlaybook** | ✅ `browser-playbook.test.ts` | — | — | ADL §2.5 步骤解析 |
| **reactToolCallSlim** | ✅ `react-tool-call-slim.test.ts` | — | — | ADL §6.5 P2.5；`__SLIM_REF__` 格式 |
| **writeContentGuard** | ✅ `write-content-guard.test.ts` | — | — | 占位符拒绝 + slim 引用格式 |
| **baseNodeWriteGuard** | ✅ `base-node-executor.test.ts` | — | — | 同路径 overwrite 拒绝 |
| **factTopic** | ✅ `fact-topic.test.ts` | — | — | ADL [`FACTS-KNOWLEDGE-GOVERNANCE.md`](./FACTS-KNOWLEDGE-GOVERNANCE.md) §4 |
| **factGovernor** | ✅ `fact-governor.test.ts` | ⏳ | — | supersede · quota · prompt cap · conflict sweep |
| **factConflict** | ✅ `fact-conflict.test.ts` | — | — | ADL §5.3 polarity · stale status |
| **factDrive9Eviction** | ⏳ | ⏳ | — | P2 drive9 sweep |
| structuredReplyParts | 🟡 parse | ✅ `structuredReplyParts.component.integration.test.ts` | — | `structured-reply-parts.test.ts` |
| innerBrainKpiReuse | ✅ `inner-brain-kpi-reuse.test.ts` | — | — | 仅 `isSetGoalDispatched` |
| innerBrainRegistry | 🟡 `inner-brain-registry.test.ts` | ✅ `innerBrainRegistry.component.integration.test.ts` | — | boot markStale；见 [`INNER-BRAIN-STARTUP-RESUME-REMOVED.md`](./INNER-BRAIN-STARTUP-RESUME-REMOVED.md) |
| innerSpawner | ❌ | ✅ `innerSpawner.component.integration.test.ts` | — | + 可选 `spawn-inner-worker-live`（`UTLRA_TEST_SPAWN_INNER=1`） |
| kpiRegistry | 🟡 `kpi-registry.test.ts` | ✅ `kpiRegistry.component.integration.test.ts` | — | |
| innerBurstExit | ✅ via `kpi-scenario.harness.test.ts` + spawn onExit | — | — | 见 [`KPI-BURST-LIFECYCLE-REMOVED.md`](./KPI-BURST-LIFECYCLE-REMOVED.md) |
| imIntentClassifier | ✅ `im-intent-classifier.test.ts`（默认 chat / followup / 收窄正则 / 去重降级 / ongoing-only）+ `kpi-description-similarity.test.ts` | ⏳ inbound IM fixture | — | ADL [`IM-INBOUND-INTENT-ROUTING.md`](./IM-INBOUND-INTENT-ROUTING.md) §3/§6/§9 |
| **agentStatusChatCommand** | ✅ `agent-activity-snapshot.test.ts`（当前进度、24h 槽位密度、状态区间、legacy 估算）+ `agent-status-chat-command.test.ts`（整句命令/格式化）+ `inner-brain-registry.test.ts`（statusHistory 持久化） | ✅ `outer-brain-inbound.integration.test.ts`（命令短路且无 LLM 可用；普通聊天仍走原降级路径） | — | 微信/聊天只读快指令；见 [`IM-INBOUND-INTENT-ROUTING.md`](./IM-INBOUND-INTENT-ROUTING.md) §4.1 |
| subKpiDecomposer | ❌ 已删除 | — | — | 扁平 KPI；见 KPI-MANAGER-LAYER.md §2.1 |
| kpiBurstState | ✅ `kpi-burst-state.test.ts` + slot-idle/advancer | — | — | R1/R2 + parallel cap + R7 熔断 gate |
| kpiFailureCircuit | ✅ `kpi-failure-circuit.test.ts`（路线级：单路线 routeBlocked / 多路线 tripped / 无 goal 兜底）+ `kpi-burst-state.test.ts`（路线分析） | — | — | ✅ P2 路线级熔断；blockedRoutes → SelfWork `route_blocked`（[`DIGITAL-EMPLOYEE-AUTONOMY.md`](./DIGITAL-EMPLOYEE-AUTONOMY.md) §6.3） |
| kpiAwaitingReview | ✅ `kpi-awaiting-review.test.ts`；⏳ 依赖粒度红测 | — | — | R3/R4；合法等待释放容量，ask_user 不阻塞同 KPI 独立工作 |
| kpiCadence | ❌ 已删除 | — | — | 不复活；业务定时归 employeeCalendar |
| kpiSlotIdle | ✅ `kpi-slot-idle.test.ts` | — | — | §5 ongoing 槽位；ask_user 不占槽（依赖级收窄，deprecated shim） |
| burstReuse | ❌ 已删除 | — | — | 见 KPI-MANAGER-LAYER.md §2.2 |
| burstRunHistory | 🟡 `burst-run-history.test.ts` | — | — | §6 执行史；✅ index.ts burst onExit 统一写入（SelfWork 去重 + R7 路线分析数据源） |
| kpiManager | ✅ `kpi-manager.test.ts` + `kpi-spawn-capacity.test.ts` | ⏳ `kpiManager.component.integration.test.ts` | — | KPI 治理 R3–R7；心跳 R1 advance 仅兼容 fallback |
| kpiAdvancer | ✅ `kpi-advancer.test.ts` | ✅ `autonomy-heartbeat` | — | IM/Ops advance；心跳经 kpiManager |
| adHocBurstAllocator | ✅ `ad-hoc-burst-allocator.test.ts` | — | — | §8 一次性任务 |
| inboundContextAssembler | — | ✅ `inbound-kpi-router.component.integration.test.ts`（只读上下文 + hint + 零副作用）+ `outer-brain-inbound-kpi-router.integration.test.ts`（前置不派发→流入对话环） | — | [`IM-INBOUND-INTENT-ROUTING.md`](./IM-INBOUND-INTENT-ROUTING.md) §4（方案一） |
| outerToolsKpiAdvancement | ✅ `outer-tools-kpi-advancement.test.ts` | — | — | `set_goal(kpi_id)` 封禁 |
| kpiCompletionJudge | ✅ `kpi-completion-judge.test.ts` | — | — | ADL [`KPI-COMPLETION-JUDGE.md`](./KPI-COMPLETION-JUDGE.md) §3b ongoing 不结案 |
| kpiFeedback | ✅ `kpi-feedback.test.ts` | — | — | ADL [`STRATEGY-PLANNING-LAYER.md`](./STRATEGY-PLANNING-LAYER.md) §16 多巴胺回路 |
| outerHeartbeat | ✅ death-detect + watchdog/fallback；接数字员工后治理-only、LLM 无 set_goal | ✅ `outer-heartbeat.integration.test.ts` + `autonomy-heartbeat.component.integration.test.ts` + `outerHeartbeatDigitalEmployee.component.integration.test.ts` | — | watchdog；非正常续派主时钟；ADL [`OUTER-HEARTBEAT-OVERSIGHT.md`](./OUTER-HEARTBEAT-OVERSIGHT.md) |
| **digitalEmployeeLoop** | ✅ `digital-employee-loop.test.ts`（优先级、single-flight、coalesce、依赖拒绝） | ✅ `digitalEmployeeLoop.component.integration.test.ts`（Calendar 优先 + burst finish 续派） | — | [`DIGITAL-EMPLOYEE-AUTONOMY.md`](./DIGITAL-EMPLOYEE-AUTONOMY.md) §5 |
| **employeeCalendar** | ✅ `employee-calendar.test.ts` + `calendar-tools.test.ts`（list/schedule/cancel/remind 幂等、白名单、cap） | ✅ loop due 链；remind→send_message / spawn→set_goal | — | ADL [`EMPLOYEE-CALENDAR.md`](./EMPLOYEE-CALENDAR.md)；对话一等工具 C1–C4 ✅ |
| **selfWorkPolicy** | ✅ `self-work-policy.test.ts`（expectedOutcome、依赖、去重、冲突、route_blocked、null 休眠）+ `self-work-strategies.test.ts`（4 策略同 fixture 可比较、角度轮换、A/B 探索/利用/回退、spec 解析）+ `self-work-metrics.test.ts`（acceptance/duplicate/no-progress/byStrategy）+ `self-work-llm-policy.test.ts`（JSON 契约、sleep、非法/异常 fallback） | ✅ 由 `digitalEmployeeLoop.component.integration.test.ts` 覆盖提案→派发 | — | 只有提案权；✅ P2 多策略 + 指标 JSONL；✅ P3 llm_reflective + AbTest 灰度（`UTLRA_SELF_WORK_STRATEGY`）；⏳ Duty 整单重放拒收见 advance WP |
| **advanceWorkPackageBuilder** | ✅ 感知 facet（日历+内脑+stall+cursor）+ 简单调配规则 | ✅ RUNNING/日历闸门；bootstrap+ensure；stall→repair；盲派/重复日历指标 | — | [`KPI-ADVANCE-WORK-PACKAGE.md`](./KPI-ADVANCE-WORK-PACKAGE.md) |
| outerMemory | ✅ `memory-belief-reconcile.test.ts` | ✅ `outerMemory.component.integration.test.ts` | — | Belief MVP |
| completionNotify | ✅ `completion-notify.test.ts` + `completion-report.test.ts` (im/verbose) + ingest R4.7 | ✅ `completionNotify.component.integration.test.ts` | — | R6.4 + dedup；IM 不 dump seed facts（§4.1）；ingest≠notify |
| **deliverableIngestOnExit** | ✅ KPI DONE：ingest 且无 IM（`ingestInnerBrainDeliverablesOnExit`） | — | — | [`DELIVERABLE-PIPELINE-GAPS.md`](./DELIVERABLE-PIPELINE-GAPS.md) Gap A · 协议 R4.7 |
| innerBurstExit | 🟡 `inner-burst-exit.test.ts` | — | — | `detectBurstGoalGaps` → partial ERROR |
| imNotifyDedup | ✅ `im-notify-dedup.test.ts` | — | — | ADL [`INNER-BRAIN-IM-NOTIFY-BOUNDARY.md`](./INNER-BRAIN-IM-NOTIFY-BOUNDARY.md) §2 |
| awaitingNotify | ✅ `awaiting-notify.test.ts` | — | — | onExit AWAITING + ask_user |
| pushLoop | ✅ `push-loop.test.ts` | ✅ `pushLoop.component.integration.test.ts` | — | BLOCK **不**推 IM；PROGRESS 可选 |
| changeWatcher | ✅ `change-watcher.test.ts` + `change-watcher.bootstrap.test.ts` | ✅ `changeWatcher.component.integration.test.ts`（含 dependency_resolved callback） | — | spawn 前 markConsumed；短等待恢复；业务长定时归 Calendar |
| brainAsyncSnapshot | ✅ `brain-async-snapshot.test.ts`（含 OUTER_ASYNC 双轨措辞） | — | — | DE §3.4 对话/心跳共用 guide |
| awaitingInboundResolver | ✅ `awaiting-inbound-resolver.test.ts` | ✅ `awaitingInboundResolver.component.integration.test.ts` | — | IM→resolve；B2 凭证→credential_ref |
| memoryBlockStore | ✅ `memory-block-store.test.ts` + `memory-block-tools.test.ts` | ✅ `memoryBlockStore.component.integration.test.ts` | — | B1 工具已接 outerToolExecutor |
| llmGateway | ✅ `raw.test.ts` 等 | ✅ `llmGateway.component.integration.test.ts` | — | |
| llmUsageTracker | ✅ `llm-usage-tracker.test.ts` | — | — | 内存滚动窗口 |
| llmUsageJournal | ✅ `llm-usage-journal.test.ts` | ✅ `llmUsageJournal.component.integration.test.ts` | — | ADL [`LLM-USAGE-JOURNAL.md`](./LLM-USAGE-JOURNAL.md) |
| environmentSensorRegistry | ✅ `environment-sensor-registry.test.ts` | ⏳ `environmentSensorRegistry.component.integration.test.ts` | — | ADL [`ENVIRONMENT-MODEL.md`](./ENVIRONMENT-MODEL.md)；P0 已实现，pipeline 经 toResourceSnapshot 适配（行为等价） |
| environmentJournal | ✅ `environment-journal.test.ts` | ⏳ `environmentJournal.component.integration.test.ts` | — | ring trim + current.json + events 月轮转 + 未消费查询 + markConsumed |
| environmentChangeDetector | ✅ `environment-change-detector.test.ts` | — | — | hysteresis / warmUp / rate·delta·streak derive |
| autonomyJudge / capacity | ✅ `autonomy-judge.test.ts` + `kpi-spawn-capacity.test.ts`（AWAITING 不占槽、前台预留/归零、foreground_reserved、inbound_pressure、reserve=0 关闭）+ `autonomy-policy-store.test.ts`（DE-4 剥 KPI 日配额/冷却/minMs） | ⏳ `autonomyJudge.component.integration.test.ts` | — | ✅ P3 自适应前台预留；DE-4 时间配额非产能闸；`blockIfOuterLoopActive` 仅兼容 advance 路径 |
| strategyStore | ❌ 已删除 | — | — | 见 KPI-MANAGER-LAYER.md |
| strategyTrigger | ❌ 已删除 | — | — | 见 KPI-MANAGER-LAYER.md |
| strategyArtifact | ❌ 已删除 | — | — | 见 KPI-MANAGER-LAYER.md |
| strategyPlanner | ❌ 已删除 | — | — | 见 DIGITAL-EMPLOYEE-AUTONOMY.md（SelfWorkPolicy 取代宏观战略神） |
| dispatchByStrategy | ❌ 已删除 | — | — | digitalEmployeeLoop + Calendar / SelfWorkPolicy |
| staleBurstReaper | ✅ `kpi/stale-burst-reaper.test.ts` | — | — | R5；自 strategy/ 迁入 |
| strategyLiveAdapter | ❌ 已删除 | — | — | 见 KPI-MANAGER-LAYER.md |
| kpiAwaitingReviewLlm | ✅ `kpi-awaiting-review-llm.test.ts` | — | — | P3 LLM JSON 解析 |
| **frameworkBenchmarkHarness** | ✅ `token-estimate.test.ts` | ✅ `framework-benchmark.component.integration.test.ts` | — | ADL [`FRAMEWORK-BENCHMARK.md`](./FRAMEWORK-BENCHMARK.md) · S1/S2 + `baseline.json` |
| **nodeDefDrive9Store** | ✅ `node-def-drive9-store.test.ts`（put/get/index/dedupe/search/tombstone） | — | — | ADL [`INNER-NODE-LIFECYCLE.md`](./INNER-NODE-LIFECYCLE.md) §5.4（P1，注入 Drive9Fs） |
| **nodeDefEviction** | ✅ `node-def-eviction.test.ts`（score + cold + quota） | — | — | dedupe + quota + cold tombstone（P2） |
| **identityLinkService** | ✅ `identity-link-tools.test.ts` + `identity-link-inbound.test.ts`（P1 工具与确认口令） | ✅ `identityLinkService.component.integration.test.ts` | — | ADL [`IDENTITY-CROSS-CHANNEL.md`](./IDENTITY-CROSS-CHANNEL.md) §3；双边确认；Agent 不裁决 |
| **channelConnectionRegistry** | ✅ `channel-connection-registry.test.ts` + `channel-connection-tools.test.ts` | — | — | ADL §5；飞书 N 连接热插；connector 注入式（kind=feishu 已注册） |

## Chat IR 库（`chatIrLib`）

| ADL 模块 ID | 单元测 | 模块测 | 备注 |
|-------------|--------|--------|------|
| ChatIRSeenTracker | ✅ `seen-tracker.test.ts` | — | freshCheck @ 语义（亦被 threadOrchestrator 引用） |
| **identityBindingIndex** | ✅ `identity-binding-index.test.ts` + `resolve-inbound-sender.test.ts` | ✅ `inbound-sender-canonicalize.component.test.ts`（server） | P0b 桥+Facade 接线 |
| **FanInChatIRChannel** | ✅ `fan-in-channel.test.ts`（合流/路由/热插/default 回退） | — | ADL [`IDENTITY-CROSS-CHANNEL.md`](./IDENTITY-CROSS-CHANNEL.md) §5.2 装配 |
| **personMessageRecall** | ✅ `person-message-recall.test.ts`（别名集折叠、跨 thread 召回、排除当前、上限） | ✅ `knowledgeRetrieval.component.integration.test.ts`（person 块） | ADL [`IDENTITY-CROSS-CHANNEL.md`](./IDENTITY-CROSS-CHANNEL.md) §6.5 P3 |
| **qrTools** | ✅ `qr-tools.test.ts`（PNG 签名、asset 落盘 + attachment 发送、空/超长拒绝） | ✅ `channel-scan-tools.test.ts`（扫码 URL 消息自动附二维码） | `outer/qr-tools.ts`；`qr_generate` |
| **visionTools** | ✅ `vision-tools.test.ts`（asset → 临时文件 → describe 注入、非图片/缺失拒绝、临时文件清理） | — | `outer/vision-tools.ts`；`view_image` |

## 飞书桥（`feishuBridge` · `packages/feishu-bridge`）

| 模块 | 单测 | 组件测 | 备注 |
|---|---|---|---|
| **FeishuApiClient** | ✅ `api-client.test.ts`（token 缓存/续取、消息、reaction、probe 失败） | — | fake fetch，不出网 |
| **handleFeishuInbound** | ✅ `inbound.test.ts`（union_id 稳定键、scope=app_id、去重、@bot、reply、降级） | — | ADL §5.1 |
| **FeishuChannel** | ✅ `feishu-channel.test.ts`（事件源、出站路由、Typing reaction 生命周期） | — | Typing 模拟见 channel-bridge-guide §5.4 |
| **createFeishuConnector** | ✅ `connector.test.ts`（探测、失败回滚、fan-in 入站约定） | — | 注册于 `index.ts` connectors map |
| **scanRegisterFeishuApp** | ✅ `scan-register.test.ts`（URL 回调、凭证返回、SDK 缺失显式报错） | ✅ `channel-scan-tools.test.ts`（server：异步流+admin 闸） | P4a，ADL §6.6 |

## 微信桥（`wechatBridge` · `packages/wechat-bridge`）

| 模块 | 单测 | 组件测 | 备注 |
|---|---|---|---|
| **IlinkApiClient** | ✅ `ilink-api-client.test.ts`（登录轮询、getupdates、sendmessage 回传 context_token、-14 过期、typing ilink_user_id/status=2、downloadMedia/uploadMedia/发图发文件） | — | fake fetch，不出网 |
| **media-crypto** | ✅ `media-crypto.test.ts`（AES key 三种编码兼容、ECB 往返、密文大小公式、图片 mime 嗅探） | — | ADL §6.6 P4b-media |
| **handleWechatInbound** | ✅ `inbound.test.ts`（message_type 过滤、去重、resolve scope=bot_id、context_token 缓存、mediaSink 镜像成功/失败降级） | — | ADL §6.6 |
| **WechatChannel** | ✅ `wechat-channel.test.ts`（长轮询源注入、出站路由、typing ticket、出站附件上传发图/发文件+失败降级、入站图片镜像） | — | |
| **createWechatConnector** | ✅ `connector.test.ts`（探测 prime、凭证 JSON 解析、失败回滚） | — | 注册于 `index.ts` connectors map（kind=wechat） |
| **thread-mapper** | ✅ `thread-mapper.test.ts` | — | `wechat:<bot_id>:dm:<user_id>` |
| **thread-mapper** | ✅ `thread-mapper.test.ts` | — | `feishu:<app_id>:chat:<chat_id>` |

## 元宝 PSTune（`data-yuanbao` workspace · ADL [`BATTLE-TUNE-LOOP.md`](./BATTLE-TUNE-LOOP.md)）

| 模块 ID | 单元测 | 模块测 | 备注 |
|---------|--------|--------|------|
| profileLoader | ✅ `profile_loader.test.mjs` | ⏳ | `tuning/profile_loader.mjs` |
| battleAnalyzer | ⏳ | ⏳ | `tuning/battle_analyzer.mjs` |
| replayInjector | — | ⏳ | 离线 replay JSON → override diff |
| pstuneCli | — | ⏳ | `pstune.mjs analyze` / `gate` |

路径根：`packages/server/data-yuanbao/workspaces/task-ib-mpvf5dh8-6070/`

## 内脑 L3（`innerWorker`）

> **DyFlow 单引擎**：旧三件套 `decomposer / executor / attributor / blockResolver` 及 `reflexion` 已删除（含全部对应测试）。详见 [`DYFLOW-INNER-EXECUTOR.md`](./DYFLOW-INNER-EXECUTOR.md)、[`INNER-NODE-LIFECYCLE.md`](./INNER-NODE-LIFECYCLE.md)。

| ADL 模块 ID | 单元测 | 模块测 | Prompt 测 | 备注 |
|-------------|--------|--------|-----------|------|
| workerHost | ❌ | ✅ `workerHost.component.integration.test.ts` | — | status.json 契约 |
| piMonoScheduler | ❌ | ✅ `piMonoScheduler.component.integration.test.ts` | — | stop 信号 + runtime 标签 |
| controllerFsm | — | ✅ `controllerFsm.component.integration.test.ts` | — | DyFlow DESIGN/RUN/AWAITING/DONE |
| completionReport | ✅ `completion-report.test.ts`（im/verbose） | — | — | burst DONE 完成报告正文 |
| **designer** | ✅ `designer.test.ts`（run/done/empty + ref 校验） | ✅ `controller.component.integration.test.ts`（DESIGN↔RUN↔DONE 全链） | ⏳ `designer.prompt.test.ts` | P0；DESIGN ↔ RUN 切换 + last_failure 决策表 |
| **runner** | ✅ `runner.test.ts`（顺序图 + terminal stop + 缺 ref + compound 展开） | ✅ `controller.component.integration.test.ts` | — | P0；顺序图 + dispatch + memory 写入 |
| **baseNodeExecutor** | ✅ `base-node-executor.test.ts`（render/terminal/allowlist/fail-fast + acceptance + shell-evidence + runtime） | — | — | P0；ReAct + §6.7 验票 |
| **nodeAcceptance** | ✅ `node-acceptance.test.ts`（json/file/string + shell 404 + deliverable AND + P-evidence） | — | — | P0b；DYFLOW §6.7 / §6.7a |
| **deliverableCheck** | ✅ `deliverable-check.test.ts`（file/json_key/stdout_* + P-alias + 绝对路径拒收） | — | — | DYFLOW §6.7a 路径规范；[`DELIVERABLE-PIPELINE-GAPS.md`](./DELIVERABLE-PIPELINE-GAPS.md) Gap B |
| **failureDistill** | ✅ `failure-distill.test.ts`（distill + dedupe append） | — | — | P0b；DYFLOW §7c |
| **runtimeContext** | ✅ `runtime-context.test.ts`（platform/shell/vault/env_keys） | — | — | P0；baseNode system 常驻环境块 |
| **resourceBudget** | ✅ `resource-budget.test.ts`（env 解析/live 块/upsert/软阈值） | — | — | P0；§6.1d 上限+当前用量披露 |
| **innerKeychainTools** | ✅ `keychain-tools.test.ts`（entries/get + 无 dataRoot） | — | — | P0；内脑 vault 只读 |
| **reactMessagePrune** | ✅ `react-message-prune.test.ts` | — | — | P2；旧轮 tool prune |
| **toolOutputSpill** | ✅ `tool-output-spill.test.ts` | — | — | P2；超大 tool 落盘 |
| **shellStallGuard** | ✅ `shell-stall-guard.test.ts` | — | — | P2；重复 shell 失败 |
| **burstStallEvaluator** | ✅ `burst-stall-evaluator.test.ts` | — | — | P0 观测；空转信号 |
| **burstStallAlert** | ✅ `burst-stall-alert.test.ts` | — | — | P0 观测；落盘 + debounce |
| **localNodeStore** | ✅ `local-node-store.test.ts`（schema/嵌套 id/穿越/index 重建） | — | — | P0；schema 校验 + index |
| **memoryStore** | ✅ `memory-store.test.ts`（点路径/last_failure/node_results/facts/dag_history 环形/locked_milestones 去重） | — | — | P0；last_failure / node_results / facts / dag_history / locked_milestones |
| **designerToolRegistry** | ✅ `search-and-instance.test.ts`（装配失败包容 + 幂等）· ✅ `search-task-plans.test.ts` | ✅ `designer.test.ts`（list/read/commit/report verify 闸门/promote/lock_milestone+拦截） | — | P0；list/read/commit/report+verify/promote/lock |
| **planReferenceSearch** | ✅ `plan-reference-search.test.ts` · ✅ `plan-reference-port.test.ts` | ⏳ `planReferenceSearch.component.integration.test.ts` | — | Designer `search_task_plans` |
| **presetSeeder** | ✅ `preset-seeder.test.ts`（首次 seed/跳过/版本升级/export=false） | — | — | P0；首次 seed + 已存在跳过 |
| **nodeAbstractor** | ✅ `node-abstractor.test.ts`（sanitize 残留/origin 过滤/dedupe） | — | ⏳ `node-abstractor.prompt.test.ts` | P1；origin 过滤 + dedupeKey |
| **nodeSkillStore** | ✅ `node-skill-store.test.ts` | — | — | ADL [`INNER-NODE-SKILLS.md`](./INNER-NODE-SKILLS.md) |
| **nodeSkillLoader** | ✅ `node-skill-loader.test.ts` | — | — | 执行前加载绑定+全局技能 |
| **dyflowAttributor** | ✅ `attributor.test.ts`（record_fact + record_skill） | ✅ `controller.component.integration.test.ts` | — | RUN→ATTRIBUTE |
| **nodeAssembler** | ✅ `node-assembler.test.ts`（applyBinding 无残留/幂等/缺 required） | — | ⏳ `node-assembler.prompt.test.ts` | P1；binding 推断 + 失败包容 |
| brainFs | ✅ `parse-milestones.test.ts` | ✅ `brainFs.component.integration.test.ts` | — | DyFlow 后仅余通用文件读写（tail 等） |
| archiveStore | ✅ `fs-store.test.ts` | ✅ `archiveStore.component.integration.test.ts` | — | |

## 实施阶段（testing-strategy §7）

| 阶段 | 状态 | 与「每组件测试」关系 |
|------|------|---------------------|
| A 设计 | ✅ | §4 矩阵 + 本文 |
| B testing kit | ✅ | fake-llm / fixture / temp-data-root |
| C 可注入重构 | ✅ | policy / controller / heartbeat / loop |
| D 单元 | ✅ 大部分 | 与组件测互补 |
| D' Prompt | ✅ DyFlow + participation | `designer` / `node-creator` / `node-abstractor` `.prompt.test.ts` |
| **E 模块黑盒** | **✅ L3 全覆盖** | 27 组件 + 既有 `integration/*` |
| F 装配 | ✅ | 上列 + `index-listen-smoke`（子进程 listen）/ `index-app-health` |
| E.1 编排 | ✅ | `await-and-wake` / `inbound-policy-table` / `outer-heartbeat` |

## 运行

```bash
npm run test:integration -w @utlra/server   # 70+ 项（含 index-listen 子进程烟测；live spawn 默认 skip）
npm run test:prompt -w @utlra/server        # 11 项（真实 LLM，缺 key 则 fail）
npm run test:unit -w @utlra/server
```

## 下一步

1. **CI nightly**（可选）`UTLRA_TEST_SPAWN_INNER=1` 跑真实内脑子进程
2. **index** 子进程内再测 `POST /api/outer/inbound`（HTTP 契约，当前由 `outer-http-inbound.integration.test.ts` 覆盖）
3. **P0 身份认同**（[`IDENTITY-CROSS-CHANNEL.md`](./IDENTITY-CROSS-CHANNEL.md)）：`identityBindingIndex` + `identityLinkService` 红测 → 实现 → 入站 resolve

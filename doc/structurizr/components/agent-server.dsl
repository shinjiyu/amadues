                // ── 入站 / 决策 ─────────────────────────────────────────
                participationPolicy = component "Participation Policy" "【是否回复】规则过滤 + 群聊@判定 + SPEAK/SILENT LLM；入站第一道闸门" "TypeScript" {
                    tags "Outer-Module" "Inbound"
                    properties {
                        "path" "packages/server/src/outer/inbound-policy.ts; participation-state.ts"
                        "horizon.intention" "决定本条消息外脑要不要说话"
                        "horizon.in" "OuterInboundMeta + 正文 + 线程历史摘要"
                        "horizon.out" "shouldReply + reason"
                        "horizon.deps" "llmGateway"
                        "horizon.test.unit" "inbound-policy.test.ts"
                        "horizon.test.integration" "participationPolicy.component.integration.test.ts"
                        "horizon.test.prompt" "inbound-policy.prompt.test.ts"
                    }
                }

                threadOrchestrator = component "Thread Orchestrator" "【线程编排】jitter/debounce + 同 thread FIFO 串行 + freshCheck（仅触发上被一并@的 agent 算抢答；独占@本 agent 不因他人插话放弃）" "TypeScript" {
                    tags "Outer-Module" "Inbound"
                    properties {
                        "path" "packages/server/src/outer/thread-orchestrator.ts; packages/chat-ir/src/seen-tracker.ts"
                        "horizon.intention" "防并发激荡；分别@不同 agent 时不互掐"
                        "horizon.in" "seenTracker(track 含 mention_target_sids) + threadId + triggerMessageId"
                        "horizon.out" "freshCheck 回调；UTLRA_ORCHESTRATOR_MAX_QUEUED 排队"
                        "horizon.test.unit" "packages/chat-ir/src/seen-tracker.test.ts"
                        "horizon.test.integration" "threadOrchestrator.component.integration.test.ts"
                    }
                }

                outerBrainFacade = component "Outer Brain Facade" "【唯一外脑入口】Discord/WebChat/HTTP 入站 → 检索 → 是否说话 → 外脑对话环" "TypeScript" {
                    tags "Outer-Module" "Inbound"
                    properties {
                        "path" "packages/server/src/outer/outer-brain.ts; packages/server/src/outer/outer-http-inbound.ts"
                        "horizon.intention" "渠道与 HTTP 统一入站编排"
                        "horizon.in" "ChatIRInboundEvent; POST /api/outer/inbound"
                        "horizon.out" "调用 knowledge / policy / conversationLoop"
                        "entry" "channel.onInbound; dispatchOuterHttpInbound"
                        "horizon.test.integration" "outerBrainFacade.component.integration.test.ts; outer-brain-inbound.integration.test.ts; outer-brain-channel-wire.integration.test.ts; outer-http-inbound.integration.test.ts"
                    }
                }

                structuredReplyParts = component "Structured Reply Parts" "reply.v1 → MessagePart[]（mention + attach 展开）" "TypeScript" {
                    tags "Outer-Module" "Outbound"
                    properties {
                        "path" "packages/server/src/outer/structured-reply-parts.ts"
                        "horizon.intention" "StructuredReply 物化为 Chat IR parts"
                        "horizon.test.unit" "structured-reply-parts.test.ts"
                        "horizon.test.integration" "structuredReplyParts.component.integration.test.ts"
                    }
                }

                knowledgeRetrieval = component "Knowledge Retrieval" "【上下文检索】本地 repository K/S/P + 本线程/跨线程历史 + 按人跨会话记忆（personMessageRecall）→ 注入 LLM 前缀" "TypeScript" {
                    tags "Outer-Module" "Inbound"
                    properties {
                        "path" "packages/server/src/outer/knowledge-retrieval.ts"
                        "horizon.intention" "拼 knowledgeContext 字符串"
                        "horizon.in" "query + threadId + workspaceId + senderSid(+bindingIndex)"
                        "horizon.out" "context + sources 统计（repo/currentThread/crossThread/person）"
                        "horizon.deps" "FilesystemRepositoryStore + chat-ir（personMessageRecall 别名集折叠）；禁止 mem9/drive9"
                        "horizon.test.integration" "knowledgeRetrieval.component.integration.test.ts"
                        "horizon.note" "P3 按人跨会话记忆：IDENTITY-CROSS-CHANNEL.md §6.5"
                    }
                }

                outerMemory = component "Outer Memory" "【外脑记忆】daily-log / tasks → mem9；Belief Card 现行结论覆盖；拼到 knowledge 前" "TypeScript" {
                    tags "Outer-Module" "Inbound"
                    properties {
                        "path" "packages/server/src/outer/outer-memory.ts; memory-belief-card.ts; memory-belief-reconcile.ts"
                        "horizon.intention" "长期任务与日志上下文；同 topic 现行结论 supersede"
                        "horizon.in" "mem9 read; workspace 证据; 用户修好/取消/完成"
                        "horizon.out" "formatMemoryForLlm（现行信念 + episodic）"
                        "horizon.deps" "mem9-client + drive9-client（本模块为唯一外脑门面）"
                        "horizon.test.unit" "memory-belief-reconcile.test.ts; memory-belief-card.test.ts"
                        "horizon.test.integration" "outerMemory.component.integration.test.ts"
                        "horizon.note" "MVP 对账 + M1 Belief Card：MEMORY-BELIEF-CARD.md"
                    }
                }

                memoryBlockStore = component "Memory Block Store" "【结构化长期记忆】Block+Strategy CRUD；keychain=kv_secret；bind→.brain/secrets" "TypeScript" {
                    tags "Outer-Module" "Conversation" "Memory"
                    properties {
                        "path" "packages/server/src/outer/memory-block-store.ts; memory-block-strategies.ts; memory-block-tools.ts"
                        "horizon.intention" "Cookie/Token/地址簿等精确 KV；与 mem9 语义记忆分离"
                        "horizon.in" "block_id + key + payload; instance_id(bind)"
                        "horizon.out" "entry metadata; workDir bind files"
                        "horizon.deps" "drive9 /vault/blocks; innerBrainRegistry(workDir); outerToolExecutor"
                        "horizon.test.unit" "memory-block-store.test.ts; memory-block-tools.test.ts"
                        "horizon.test.integration" "memoryBlockStore.component.integration.test.ts"
                        "horizon.note" "B0+B1 已实现；keychain_* 别名"
                    }
                }

                // ── 对话 / 工具 ─────────────────────────────────────────
                outerConversationLoop = component "Outer Conversation Loop" "【外脑多轮】LLM ↔ tools 循环直到 reply_to_user 或达上限；空口承诺 post-loop 对账" "TypeScript" {
                    tags "Outer-Module" "Conversation"
                    properties {
                        "path" "packages/server/src/outer/outer-conversation-loop.ts"
                        "horizon.intention" "外脑 ReAct 环 + emptyPromiseReconcile"
                        "horizon.in" "userMessage + knowledgeContext + soul"
                        "horizon.out" "tool_calls 或最终回复"
                        "horizon.deps" "emptyPromiseReconcile"
                        "horizon.test.unit" "outer-conversation-loop.test.ts; empty-promise-reconcile.test.ts"
                        "horizon.test.integration" "outerConversationLoop.component.integration.test.ts; outer-conversation-loop-assembly.integration.test.ts"
                        "horizon.note" "方案一不盲派；§4.2 口头承诺须成功派活或改口"
                    }
                }

                emptyPromiseReconcile = component "Empty Promise Reconcile" "【空口对账】用户祈使+口头承诺+无成功派活 → 强制再跑一轮工具环" "TypeScript" {
                    tags "Outer-Module" "Conversation"
                    properties {
                        "path" "packages/server/src/outer/empty-promise-reconcile.ts"
                        "horizon.intention" "post-loop 承诺↔派发对账（不恢复前置短路）"
                        "horizon.in" "userMessage + replyTexts + toolResults"
                        "horizon.out" "shouldReconcile boolean + recovery system prompt"
                        "horizon.test.unit" "empty-promise-reconcile.test.ts"
                        "horizon.note" "见 IM-INBOUND-INTENT-ROUTING.md §4.2"
                    }
                }

                outerToolExecutor = component "Outer Tool Executor" "工具执行：reply_to_user / set_goal 派一名新工人 / list_brains / read_inner_status" "TypeScript" {
                    tags "Outer-Module" "Conversation"
                    properties {
                        "horizon.status" "改写 · 见 WORKSHOP.md"
                        "path" "packages/server/src/outer/outer-tools.ts"
                        "horizon.intention" "执行 LLM 返回的每个 tool_call"
                        "horizon.in" "tool name + args"
                        "horizon.out" "渠道 postMessage；spawn；registry 更新"
                        "horizon.deps" "workspaceInbox; innerBrainRegistry; timerManager"
                        "horizon.test.integration" "outerToolExecutor.component.integration.test.ts"
                        "horizon.note" "set_goal 派新工人并上班读日志；见 WORKSHOP.md"
                    }
                }

                llmGateway = component "LLM Gateway" "【模型网关】参与判别、外脑对话、复盘、roundtrip 草稿；Zhipu/Kimi/LocalModule" "TypeScript" {
                    tags "Outer-Module" "Shared"
                    properties {
                        "path" "packages/server/src/llm/"
                        "horizon.intention" "统一 LLM HTTP 调用"
                        "horizon.in" "messages + tools"
                        "horizon.out" "text / tool_calls"
                        "horizon.test.unit" "raw.test.ts"
                        "horizon.test.integration" "llmGateway.component.integration.test.ts"
                    }
                }

                // ── 内脑生命周期 ───────────────────────────────────────
                innerBrainRegistry = component "Inner Brain Registry" "【内脑任务表】instanceId、RUNNING/DONE/AWAITING、workDir；boot markStale 不 auto-resume" "TypeScript" {
                    tags "Outer-Module" "Inner-Lifecycle"
                    properties {
                        "path" "packages/server/src/outer/inner-brain-registry.ts"
                        "horizon.intention" "burst 实例状态机（磁盘 JSON）；外脑重启 markStaleRunningAsStopped"
                        "horizon.in" "register / update / list / remove"
                        "horizon.out" "TaskRecord; markStaleRunningAsStopped(); remove(instanceId)"
                        "horizon.test.unit" "inner-brain-registry.test.ts"
                        "horizon.test.integration" "innerBrainRegistry.component.integration.test.ts"
                        "horizon.note" "启动不自动续跑。remove 供 innerWorkspaceRetention"
                    }
                }

                innerWorkspaceRetention = component "Inner Workspace Retention" "【终态淘汰】心跳 cold+quota：删 registry 行与 workspaces/task-*；永不碰 live" "TypeScript" {
                    tags "Outer-Module" "Inner-Lifecycle" "Heartbeat"
                    properties {
                        "path" "packages/server/src/outer/inner-workspace-retention.ts"
                        "horizon.intention" "防 registry/workspace 爆炸与 include_history 扫全表卡死事件循环"
                        "horizon.in" "innerBrainRegistry + dataRoot + maxTerminal/coldDays"
                        "horizon.out" "removed[]；磁盘 rm 仅限 dataRoot/workspaces/"
                        "horizon.deps" "innerBrainRegistry"
                        "horizon.test.unit" "inner-workspace-retention.test.ts"
                        "horizon.note" "见 INNER-WORKSPACE-RETENTION.md；read_inner_status historyCap 在 outer-tools"
                    }
                }

                workshopLedger = component "Workshop Ledger" "【车间余量】浏览器实例池；每轮披露空闲数，browser_open 时领取或拒绝；不挡派工" "TypeScript" {
                    tags "Outer-Module" "Workshop"
                    properties {
                        "path" "packages/server/src/workshop/resource-ledger.ts"
                        "horizon.intention" "工人自己看余量安排工作；领取发生在打开浏览器时"
                        "horizon.in" "WORKSHOP_BROWSER_CAPACITY + 已发放的 grant"
                        "horizon.out" "余量文本；grant / refuse / release"
                        "horizon.deps" "browserSessionRegistry; inner-brain-worker; index onExit"
                        "horizon.test.unit" "resource-ledger.test.ts"
                        "horizon.note" "权威规则见 WORKSHOP.md §4"
                    }
                }

                workspaceInbox = component "Workspace Inbox" "上班读其他工作台日志：collectPeerWorkspaceIds + writePeerCatalog；spawn 注入 INNER_PEER_WORKSPACE_IDS" "TypeScript" {
                    tags "Outer-Module" "Inner-Lifecycle"
                    properties {
                        "horizon.status" "改写 · 见 WORKSHOP.md"
                        "path" "packages/server/src/outer/workspace-inbox.ts"
                        "horizon.intention" "新工人上班时只读其他工作台日志；spawn 只写 .inbox/ 目录，不传正文"
                        "horizon.in" "innerBrainRegistry + explicit peer_workspace_ids"
                        "horizon.out" ".inbox/catalog.json + README.md; peer id 列表 → innerSpawner env"
                        "horizon.deps" "innerBrainRegistry; outerToolExecutor(set_goal); index spawnAndAttachWorker"
                        "horizon.test.unit" "workspace-inbox.test.ts"
                        "horizon.note" "权威规则见 WORKSHOP.md"
                    }
                }

                innerSpawner = component "Inner Spawner" "【子进程】spawn inner-brain-worker；env 传 workDir + INNER_PEER_WORKSPACE_IDS" "TypeScript" {
                    tags "Outer-Module" "Inner-Lifecycle"
                    properties {
                        "path" "packages/server/src/pi-mono/inner-brain-spawner.ts"
                        "horizon.intention" "进程级隔离内脑"
                        "horizon.in" "instanceId + workDir + maxTicks + peerWorkspaceIds"
                        "horizon.out" "pid + status 文件"
                        "horizon.test.integration" "innerSpawner.component.integration.test.ts; spawn-inner-worker-live.integration.test.ts"
                        "horizon.note" "restart：index spawnAndAttachWorker 亦经 workspaceInbox 刷新 peer+catalog"
                    }
                }

                brainAsyncSnapshot = component "Brain Async Snapshot" "【只读视图】workDir → is_async_waiting / is_post_complete / active_pendings / next_wake_at；registry 与 IM 解析共用" "TypeScript" {
                    tags "Outer-Module" "Inner-Lifecycle"
                    properties {
                        "path" "packages/server/src/outer/brain-async-snapshot.ts"
                        "horizon.intention" "双状态机对齐的单一真相来源（workDir 侧）"
                        "horizon.in" "workDir"
                        "horizon.out" "BrainAsyncSnapshot"
                        "horizon.test.unit" "brain-async-snapshot.test.ts"
                        "horizon.note" "权威规则见 INNER-BRAIN-AWAITING-LIFECYCLE.md §4"
                    }
                }

                innerBurstExit = component "Inner Burst Exit" "【burst onExit】countDeliverables；DyFlow 失败；goal 缺口（部署 BLOCKED）→ partial ERROR" "TypeScript" {
                    tags "Outer-Module" "Inner-Lifecycle"
                    properties {
                        "path" "packages/server/src/outer/inner-burst-exit.ts"
                        "horizon.intention" "onExit 不另派工人；交付缺口记为未完成"
                        "horizon.in" "workDir + exitCode"
                        "horizon.out" "finalStatus; partialWithDeliverables"
                        "horizon.test.unit" "inner-burst-exit.test.ts; kpi-scenario.harness.test.ts"
                        "horizon.note" "见 INNER-BRAIN-IM-NOTIFY-BOUNDARY.md PARTIAL"
                    }
                }

                imIntentClassifier = component "IM Intent Classifier" "入站意图：默认 chat_only / task_followup / ad_hoc_task。长期说法留在对话里拆开" "TypeScript" {
                    tags "Outer-Module" "Inbound"
                    properties {
                        "horizon.status" "改写 · 见 WORKSHOP.md"
                        "path" "packages/server/src/outer/inbound/im-intent-classifier.ts"
                        "horizon.intention" "模糊默认聊天；长期/周期留在对话里拆成可执行任务；跟进既有任务不新建"
                        "horizon.in" "IM 文本 + 轻量上下文（在跑任务 / 最近 thread）"
                        "horizon.out" "ImInboundIntent（chat_only|task_followup|ad_hoc_task）"
                        "horizon.test.unit" "im-intent-classifier.test.ts"
                        "horizon.note" "见 WORKSHOP.md"
                    }
                }

                agentStatusChatCommand = component "Agent Status Chat Command" "【改写】【只读快指令】状态/进度 → 当前快照；密度/今天 → 过去 24h 执行槽位利用率；无 LLM" "TypeScript" {
                    tags "Outer-Module" "Inbound" "Monitoring"
                    properties {
                        "horizon.status" "改写 · 见 WORKSHOP.md"
                        "path" "packages/server/src/outer/inbound/agent-status-chat-command.ts; packages/server/src/outer/agent-activity-snapshot.ts"
                        "horizon.intention" "手机/微信中快速查看当前进度与 24h 工作密度；不打开 Dashboard、不扫描 brain-inspector"
                        "horizon.in" "整句聊天命令 + innerBrainRegistry + now"
                        "horizon.out" "当前进度文本或 24h 密度文本 → 当前 thread"
                        "horizon.deps" "innerBrainRegistry"
                        "horizon.test.unit" "agent-activity-snapshot.test.ts; agent-status-chat-command.test.ts"
                        "horizon.test.integration" "agentStatusChatCommand.component.integration.test.ts"
                        "horizon.note" "只读、零副作用；整句匹配；AWAITING 不计执行密度；见 IM-INBOUND-INTENT-ROUTING.md §4.1"
                    }
                }

                awaitingInboundResolver = component "Awaiting Inbound Resolver" "【改写】【IM 必达】人消息 → 同 thread 的 ask_user pending → resolved；拒 agent-mirror/通知 echo" "TypeScript" {
                    tags "Outer-Module" "Inbound" "Inner-Lifecycle"
                    properties {
                        "horizon.status" "改写 · 见 WORKSHOP.md"
                        "path" "packages/server/src/outer/awaiting-inbound-resolver.ts"
                        "horizon.intention" "宪法 IMWatcher 的确定性实现；不依赖 LLM 调 send_directive"
                        "horizon.in" "ChatIRInboundEvent(human) + innerBrainRegistry"
                        "horizon.out" "resolvePending on workDir"
                        "horizon.deps" "brainAsyncSnapshot; innerBrainRegistry"
                        "horizon.test.unit" "awaiting-inbound-resolver.test.ts"
                        "horizon.test.integration" "awaitingInboundResolver.component.integration.test.ts"
                        "horizon.note" "挂载于 outerBrainFacade，policy 之后、conversationLoop 之前；见 INNER-BRAIN-IM-NOTIFY-BOUNDARY.md §5"
                    }
                }

                completionNotify = component "Completion Notify" "【改写】【完成/部分/失败通知】DONE→✅；partial ERROR→⚠️+附件；crash→❌" "TypeScript" {
                    tags "Outer-Module" "Inner-Lifecycle"
                    properties {
                        "horizon.status" "改写 · 见 WORKSHOP.md"
                        "path" "packages/server/src/outer/completion-notify.ts; openkuroneko/burst/completion-report.ts"
                        "horizon.intention" "onExit 主路径：结果摘要 + 产出附件，不堆 milestones/reflexion 过程"
                        "horizon.in" "TaskRecord + workDir(.brain + deliverables + output COMPLETE)"
                        "horizon.out" "postMessage(text≤3.2k + attachment parts); outerMemory 用 audience=verbose"
                        "horizon.protocol" "doc/protocols/inner-brain-deliverables.md §6.4"
                        "horizon.test.unit" "completion-notify.test.ts; completion-report.test.ts"
                        "horizon.test.integration" "completionNotify.component.integration.test.ts"
                        "horizon.note" "见 INNER-BRAIN-IM-NOTIFY-BOUNDARY.md §4"
                    }
                }

                pushLoop = component "Push Loop" "【增量推送】轮询 RUNNING 实例 output；仅 PROGRESS 可选推 IM；BLOCK 只记日志" "TypeScript" {
                    tags "Outer-Module" "Inner-Lifecycle"
                    properties {
                        "path" "packages/server/src/outer/push-loop.ts"
                        "horizon.intention" "长任务中途进度；等人时不另发固定句"
                        "horizon.in" "registry 列表 + offset 文件"
                        "horizon.out" "imClient.postMessage (PROGRESS only)"
                        "horizon.test.integration" "pushLoop.component.integration.test.ts"
                        "horizon.note" "见 INNER-BRAIN-IM-NOTIFY-BOUNDARY.md §1"
                    }
                }

                // ── 定时 ────────────────────────────────────────────────

                employeeCalendar = component "Employee Calendar" "【改写】【数字员工日程表】once/interval/cron 持久化承诺；due/missed；到期不占等待 worker" "TypeScript" {
                    tags "Outer-Module" "Autonomy" "Scheduler"
                    properties {
                        "horizon.status" "改写 · 见 WORKSHOP.md"
                        "path" "packages/server/src/scheduler/employee-calendar.ts; packages/server/src/openkuroneko/scheduled-tasks/"
                        "horizon.intention" "复用现有 Scheduler/TaskScheduler，统一业务日程真相；到期触发主循环"
                        "horizon.in" "CalendarCommitment CRUD + wall clock + capacity result"
                        "horizon.out" "calendar_due event + due/missed/status/history"
                        "horizon.deps" "TaskStore; CronParser; timerManager"
                        "horizon.test.unit" "task-scheduler.test.ts; employee-calendar.test.ts"
                        "horizon.note" "到点由定时管理器派一名工人；missed 保持 due"
                    }
                }

                llmUsageTracker = component "LLM Usage Tracker" "【LLM 计量】in-flight 计数 + usage 滚动窗口（prompt/completion tokens）" "TypeScript" {
                    tags "Outer-Module" "Autonomy"
                    properties {
                        "path" "packages/server/src/outer/llm-usage-tracker.ts"
                        "horizon.intention" "token 与并发计数；完成时委托 journal 落盘"
                        "horizon.in" "llmRawChatCompletion / pi-mono adapter 完成事件"
                        "horizon.out" "LlmUsageSnapshot"
                        "horizon.deps" "llmGateway; llmUsageJournal"
                        "horizon.test.unit" "llm-usage-tracker.test.ts"
                    }
                }

                llmUsageJournal = component "LLM Usage Journal" "【Token 统计】usage/llm-usage.jsonl 持久化 + 按 source/model 聚合" "TypeScript" {
                    tags "Outer-Module" "Observability"
                    properties {
                        "path" "packages/server/src/outer/llm-usage-journal.ts"
                        "horizon.intention" "Agent token 账单：持久化每次 LLM 调用的 usage"
                        "horizon.in" "LlmUsageJournalEntry"
                        "horizon.out" "LlmUsageSummary; GET /api/usage/summary"
                        "horizon.test.unit" "llm-usage-journal.test.ts"
                        "horizon.test.integration" "llmUsageJournal.component.integration.test.ts"
                        "horizon.note" "见 LLM-USAGE-JOURNAL.md"
                    }
                }

                // ── DyFlow 节点共享层（drive9 /nodes/shared/）──────────────────────────
                nodeDefDrive9Store = component "NodeDef drive9 Store" "drive9 /nodes/shared/ 客户端：list/get/put/tombstone + index.json 维护 + dedupeKey 查询" "TypeScript" {
                    tags "Outer-Module" "DyFlow-Lifecycle" "Planned-P1"
                    properties {
                        "path" "packages/server/src/drive9/node-def-drive9-store.ts"
                        "horizon.intention" "唯一 drive9 /nodes/shared/ 门面；Abstractor/Assembler/Eviction 都经此模块"
                        "horizon.in" "NodeDef put / search(query, tags) / tombstone(id@ver) / index"
                        "horizon.out" "drive9 HTTPS"
                        "horizon.deps" "drive9-client（同 skillDrive9Store/knowledgeDrive9Store 同级别）"
                        "horizon.test.unit" "node-def-drive9-store.test.ts"
                        "horizon.test.integration" "nodeDefDrive9Store.component.integration.test.ts"
                        "horizon.note" "schema 见 INNER-NODE-LIFECYCLE.md §4/§5.4；search grep 空不回退全库"
                    }
                }

                nodeDefEviction = component "NodeDef Eviction" "NodeDef 治理：dedupe + quota + cold tombstone" "TypeScript" {
                    tags "Outer-Module" "Heartbeat" "DyFlow-Lifecycle"
                    properties {
                        "path" "packages/server/src/outer/node-def-eviction.ts"
                        "horizon.intention" "防 NodeDef 爆炸；importCount/citeCount/age 评分 + 配额 + tombstone（不删原文）"
                        "horizon.in" "nodeDefDrive9Store.index + 配额（maxActive，默认 200）"
                        "horizon.out" "tombstone marks（cold + quota 两类）"
                        "horizon.deps" "nodeDefDrive9Store"
                        "horizon.test.unit" "node-def-eviction.test.ts"
                        "horizon.note" "模块留下。触发不再挂 KPI 心跳，见 WORKSHOP.md §11。scoreEntry + runNodeDefEviction：cold(importCount==0 && ageDays>coldDays) → quota(按 score 升序至 floor(max*(1-headroom)))；见 INNER-NODE-LIFECYCLE.md §7"
                    }
                }

                // ── Executable Workflow（确定性工作流 ⊃ Skills）──────────────────────────
                executableWorkflowStore = component "Executable Workflow Store" "【⏳】版本化确定性工作流注册表；Skills/playbook/frozen_dag 等为 kind" "TypeScript" {
                    tags "Outer-Module" "Executable-Workflow" "Planned-P0"
                    properties {
                        "path" "packages/server/src/outer/executable-workflow-store.ts"
                        "horizon.intention" "EW CRUD + version；P0 本地 DATA_ROOT/workflows；P1 drive9 /workflows/shared/"
                        "horizon.in" "id/version get · list · put"
                        "horizon.out" "ExecutableWorkflow"
                        "horizon.deps" "filesystem；P1 drive9-client"
                        "horizon.test.unit" "executable-workflow-store.test.ts"
                        "horizon.note" "见 EXECUTABLE-WORKFLOW.md；Skill ⊂ EW"
                    }
                }

                workflowPromote = component "Workflow Promote" "【⏳】探索产物冻结为 EW；无 expect 拒收；version bump" "TypeScript" {
                    tags "Outer-Module" "Executable-Workflow" "Planned-P0"
                    properties {
                        "path" "packages/server/src/outer/workflow-promote.ts"
                        "horizon.intention" "从 workspace skill/playbook/dag 组装可执行契约"
                        "horizon.in" "workDir + kind hints"
                        "horizon.out" "ExecutableWorkflow@version → store"
                        "horizon.deps" "executableWorkflowStore"
                        "horizon.test.unit" "workflow-promote.test.ts"
                        "horizon.note" "不变量 W1–W4；见 EXECUTABLE-WORKFLOW.md §6"
                    }
                }

                workflowOutcomeEvaluator = component "Workflow Outcome Evaluator" "【✅】execute settle 质检；机械 ok + 产物登记" "TypeScript" {
                    tags "Outer-Module" "Executable-Workflow"
                    properties {
                        "path" "packages/server/src/outer/workflow-outcome-evaluator.ts"
                        "horizon.intention" "判定 EW 是否需要 Agent 自优化修订"
                        "horizon.in" "workDir · workflow_run.json · allowlist deliverables"
                        "horizon.out" "WorkflowOutcomeEvaluation"
                        "horizon.deps" "ew-deliverable-allowlist"
                        "horizon.test.unit" "workflow-outcome-evaluator.test.ts"
                        "horizon.note" "W15；见 EXECUTABLE-WORKFLOW.md §6.2"
                    }
                }

                burstModeGate = component "Burst Mode Gate" "【⏳】set_goal / Designer 按 explore|execute 收权" "TypeScript" {
                    tags "Outer-Module" "Executable-Workflow" "Planned-P0"
                    properties {
                        "path" "packages/server/src/outer/burst-mode-gate.ts"
                        "horizon.intention" "execute 必绑 workflowRef；禁静默 redesign"
                        "horizon.in" "set_goal args · burstMode"
                        "horizon.out" "allow/deny + 注入 runner 模式"
                        "horizon.deps" "executableWorkflowStore；inner designer/controller"
                        "horizon.test.unit" "burst-mode-gate.test.ts"
                        "horizon.note" "缺省 explore 兼容现状；见 EXECUTABLE-WORKFLOW.md §5"
                    }
                }

                identityLinkService = component "Identity Link Service" "【跨渠道同人】双边确认状态机；唯一日常 commit 映射的入口；Agent 不裁决" "TypeScript" {
                    tags "Outer-Module" "Identity"
                    properties {
                        "path" "packages/server/src/outer/identity-link-service.ts"
                        "horizon.intention" "pending_link → 对端确认 → identityBindingIndex.linkMerge；拒绝单方自称与 LLM 改表"
                        "horizon.in" "identity_link_request；confirm/reject 回调（channel_key 鉴权）；adminForce"
                        "horizon.out" "pending 落盘；确认消息投递；committed 映射"
                        "horizon.deps" "chat-ir identityBindingIndex；imClient；审计"
                        "horizon.adl" "doc/structurizr/IDENTITY-CROSS-CHANNEL.md §3"
                        "horizon.test.unit" "identity-link-tools.test.ts; identity-link-inbound.test.ts"
                        "horizon.test.integration" "identityLinkService.component.integration.test.ts"
                        "horizon.status" "✅ P0+P1（工具 + 入站确认口令）"
                    }
                }

                channelConnectionRegistry = component "Channel Connection Registry" "【IM 连接表】N 条飞书等连接；运行时热插；secret 仅 keychain ref" "TypeScript" {
                    tags "Outer-Module" "Identity"
                    properties {
                        "path" "packages/server/src/outer/channel-connection-registry.ts"
                        "horizon.intention" "飞书通道非单例；聊天交付 app 凭证 → add client；非身份同人裁决"
                        "horizon.in" "feishu_channel_add/list/remove；boot load connections.json"
                        "horizon.out" "connection 状态；启动/停止 bridge client；agent feishu binding"
                        "horizon.deps" "memoryBlockStore keychain；feishuBridge（⏳）；identityBindingIndex（bot bind）"
                        "horizon.adl" "doc/structurizr/IDENTITY-CROSS-CHANNEL.md §5"
                        "horizon.test.unit" "channel-connection-registry.test.ts"
                        "horizon.note" "入站合流/出站路由由 chat-ir FanInChatIRChannel 承担（fan-in-channel.test.ts）；registry 只管连接元数据与生命周期"
                        "horizon.status" "✅ P2+P2b（registry+Fan-in+feishu connector 全落地）"
                    }
                }

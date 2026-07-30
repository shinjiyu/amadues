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

                outerToolExecutor = component "Outer Tool Executor" "【工具执行】reply_to_user / set_goal（KPI 单实例复用 + peer catalog）/ list_brains / read_inner_status / KPI 等" "TypeScript" {
                    tags "Outer-Module" "Conversation" "KPI"
                    properties {
                        "path" "packages/server/src/outer/outer-tools.ts"
                        "horizon.intention" "执行 LLM 返回的每个 tool_call"
                        "horizon.in" "tool name + args"
                        "horizon.out" "渠道 postMessage；spawn；registry 更新"
                        "horizon.deps" "innerBrainKpiReuse; workspaceInbox; kpiDispatchGuard"
                        "horizon.test.integration" "outerToolExecutor.component.integration.test.ts"
                        "horizon.note" "set_goal → workspaceInbox.prepareKpiPeerHandoff；见 INNER-WORKSPACE-INBOX.md"
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
                    tags "Outer-Module" "Inner-Lifecycle" "KPI"
                    properties {
                        "path" "packages/server/src/outer/inner-brain-registry.ts"
                        "horizon.intention" "burst 实例状态机（磁盘 JSON）；外脑重启 markStaleRunningAsStopped"
                        "horizon.in" "register / update / list / remove"
                        "horizon.out" "TaskRecord; markStaleRunningAsStopped(); remove(instanceId)"
                        "horizon.test.unit" "inner-brain-registry.test.ts"
                        "horizon.test.integration" "innerBrainRegistry.component.integration.test.ts"
                        "horizon.note" "auto-resume 已删见 INNER-BRAIN-STARTUP-RESUME-REMOVED.md；续跑 changeWatcher/kpiAdvancer/POST restart；remove 供 innerWorkspaceRetention"
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

                innerBrainKpiReuse = component "Inner Brain KPI Reuse" "【set_goal 判定】isSetGoalDispatched；canonical 复用已删（KPI-MANAGER-LAYER.md）" "TypeScript" {
                    tags "Outer-Module" "Inner-Lifecycle" "KPI"
                    properties {
                        "path" "packages/server/src/outer/inner-brain-kpi-reuse.ts"
                        "horizon.intention" "autonomy/heartbeat 识别 set_goal 是否成功派发"
                        "horizon.in" "set_goal tool output string"
                        "horizon.out" "boolean dispatched"
                        "horizon.deps" "—"
                        "horizon.test.unit" "inner-brain-kpi-reuse.test.ts"
                        "horizon.note" "多 burst 新 workspace；见 KPI-MANAGER-LAYER.md §2.2"
                    }
                }

                workspaceInbox = component "Workspace Inbox" "【同 KPI 互读】collectPeerWorkspaceIds + writePeerCatalog（名字/摘要）；spawn 注入 INNER_PEER_WORKSPACE_IDS" "TypeScript" {
                    tags "Outer-Module" "Inner-Lifecycle" "KPI"
                    properties {
                        "path" "packages/server/src/outer/workspace-inbox.ts"
                        "horizon.intention" "同 KPI sibling workspace 完全互读；spawn 只写 .inbox/ 目录，不传正文"
                        "horizon.in" "innerBrainRegistry + kpiRegistry + explicit peer_workspace_ids"
                        "horizon.out" ".inbox/catalog.json + README.md; peer id 列表 → innerSpawner env"
                        "horizon.deps" "innerBrainRegistry; kpiRegistry; outerToolExecutor(set_goal); index spawnAndAttachWorker"
                        "horizon.test.unit" "workspace-inbox.test.ts"
                        "horizon.note" "权威规则见 INNER-WORKSPACE-INBOX.md"
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
                    tags "Outer-Module" "Inner-Lifecycle" "KPI"
                    properties {
                        "path" "packages/server/src/outer/inner-burst-exit.ts"
                        "horizon.intention" "onExit 不 spawn、不 KPI 换向；detectBurstGoalGaps 防假 ✅"
                        "horizon.in" "workDir + exitCode"
                        "horizon.out" "finalStatus; partialWithDeliverables"
                        "horizon.test.unit" "inner-burst-exit.test.ts; kpi-scenario.harness.test.ts"
                        "horizon.note" "见 INNER-BRAIN-IM-NOTIFY-BOUNDARY.md PARTIAL"
                    }
                }

                imIntentClassifier = component "IM Intent Classifier" "【入站意图】上下文感知分类：默认 chat_only / task_followup / ad_hoc / kpi_update / kpi_create(ongoing,confirm)；正则兜底 + (P6) LLM" "TypeScript" {
                    tags "Outer-Module" "Inbound"
                    properties {
                        "path" "packages/server/src/outer/inbound/im-intent-classifier.ts"
                        "horizon.intention" "模糊默认 chat；显式长期才 KPI；跟进既有任务不新建（见 IM-INBOUND-INTENT-ROUTING.md）"
                        "horizon.in" "IM 文本 + 轻量上下文（active KPI / 在跑 burst / 最近 thread）"
                        "horizon.out" "ImInboundIntent（chat_only|task_followup|ad_hoc_task|kpi_update|kpi_create）"
                        "horizon.test.unit" "im-intent-classifier.test.ts"
                        "horizon.note" "收窄 KPI 正则（去裸 启动/设定/新增）；kpi_update 真正产出；见 IM-INBOUND-INTENT-ROUTING.md §3/§6"
                    }
                }

                inboundKpiRouter = component "Inbound Context Assembler" "【方案一·只读】装配本人 active KPI + 在跑 burst → renderInboundHint 注入对话环；前置层不派发（派发交对话环 LLM 工具）" "TypeScript" {
                    tags "Outer-Module" "Inbound"
                    properties {
                        "path" "packages/server/src/outer/inbound/inbound-kpi-router.ts"
                        "horizon.intention" "前置层零副作用，只提供上下文；create/dispatch/followup 全由对话环 LLM 用工具决定（消除误判不可恢复）"
                        "horizon.in" "kpiRegistry / innerBrainRegistry（只读）+ originUser + threadId"
                        "horizon.out" "{ activeKpis, liveBursts } → inboundHint 字符串（注入 fullContext）"
                        "horizon.deps" "kpiRegistry; innerBrainRegistry（均只读）"
                        "horizon.test.integration" "inbound-kpi-router.component.integration.test.ts; outer-brain-inbound-kpi-router.integration.test.ts"
                        "horizon.note" "挂载于 outerBrainFacade Step 3.4（不 return）；派发入口为 set_goal/set_kpi/advance_kpi/send_directive 工具；见 IM-INBOUND-INTENT-ROUTING.md §4"
                    }
                }

                agentStatusChatCommand = component "Agent Status Chat Command" "【只读快指令】状态/进度 → 当前快照；密度/今天 → 过去 24h 执行槽位利用率；无 LLM" "TypeScript" {
                    tags "Outer-Module" "Inbound" "Monitoring"
                    properties {
                        "path" "packages/server/src/outer/inbound/agent-status-chat-command.ts; packages/server/src/outer/agent-activity-snapshot.ts"
                        "horizon.intention" "手机/微信中快速查看当前进度与 24h 工作密度；不打开 Dashboard、不扫描 brain-inspector"
                        "horizon.in" "整句聊天命令 + innerBrainRegistry + kpiRegistry + AutonomyPolicy + now"
                        "horizon.out" "当前进度文本或 24h 密度文本 → 当前 thread"
                        "horizon.deps" "innerBrainRegistry; kpiRegistry; autonomyPolicyStore"
                        "horizon.test.unit" "agent-activity-snapshot.test.ts; agent-status-chat-command.test.ts"
                        "horizon.test.integration" "agentStatusChatCommand.component.integration.test.ts"
                        "horizon.note" "只读、零副作用；整句匹配；AWAITING 不计执行密度；见 IM-INBOUND-INTENT-ROUTING.md §4.1"
                    }
                }

                awaitingInboundResolver = component "Awaiting Inbound Resolver" "【IM 必达】人消息 → 同 thread 的 ask_user pending → resolved；拒 agent-mirror/通知 echo" "TypeScript" {
                    tags "Outer-Module" "Inbound" "Inner-Lifecycle"
                    properties {
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

                imNotifyDedup = component "IM Notify Dedup" "【通知去重】awaiting_human / complete fingerprint → .run/im-notify-ledger.json" "TypeScript" {
                    tags "Outer-Module" "Inner-Lifecycle"
                    properties {
                        "path" "packages/server/src/outer/im-notify-dedup.ts"
                        "horizon.intention" "防同一阻塞/完成连发 IM"
                        "horizon.in" "workDir + kind + fingerprint"
                        "horizon.out" "shouldSend / recordSent"
                        "horizon.test.unit" "im-notify-dedup.test.ts"
                        "horizon.note" "见 INNER-BRAIN-IM-NOTIFY-BOUNDARY.md §2"
                    }
                }

                awaitingNotify = component "Awaiting Notify" "【等待人类】onExit AWAITING + ask_user pending → ⏸ IM（dedup）" "TypeScript" {
                    tags "Outer-Module" "Inner-Lifecycle"
                    properties {
                        "path" "packages/server/src/outer/awaiting-notify.ts"
                        "horizon.intention" "替代 pushLoop BLOCK 与 legacy output BLOCK onExit"
                        "horizon.in" "TaskRecord + workDir + imClient"
                        "horizon.out" "postMessage or skip"
                        "horizon.deps" "imNotifyDedup; brainAsyncSnapshot"
                        "horizon.test.unit" "awaiting-notify.test.ts"
                        "horizon.note" "见 INNER-BRAIN-IM-NOTIFY-BOUNDARY.md §3"
                    }
                }

                completionNotify = component "Completion Notify" "【完成/部分/失败通知】DONE→✅；partial ERROR→⚠️+附件；crash→❌" "TypeScript" {
                    tags "Outer-Module" "Inner-Lifecycle"
                    properties {
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
                        "horizon.intention" "长任务中途进度；AWAITING_HUMAN 由 awaitingNotify"
                        "horizon.in" "registry 列表 + offset 文件"
                        "horizon.out" "imClient.postMessage (PROGRESS only)"
                        "horizon.test.integration" "pushLoop.component.integration.test.ts"
                        "horizon.note" "见 INNER-BRAIN-IM-NOTIFY-BOUNDARY.md §1"
                    }
                }

                changeWatcher = component "Change Watcher" "【AWAITING 唤醒】tick：unconsumed resolved → markConsumed → spawn" "TypeScript" {
                    tags "Outer-Module" "Inner-Lifecycle"
                    properties {
                        "path" "packages/server/src/pi-mono/change-watcher.ts"
                        "horizon.intention" "pendings 到期/解封后 spawn；spawn 前消费 resolved 防重唤醒"
                        "horizon.in" "innerBrainRegistry AWAITING|BLOCKED 列表"
                        "horizon.out" "innerSpawner spawn"
                        "horizon.test.unit" "change-watcher.test.ts"
                        "horizon.test.integration" "changeWatcher.component.integration.test.ts; await-and-wake.integration.test.ts"
                        "horizon.note" "见 INNER-BRAIN-AWAITING-LIFECYCLE.md §5.3; INNER-BRAIN-IM-NOTIFY-BOUNDARY.md §6"
                    }
                }

                // ── KPI ─────────────────────────────────────────────────
                kpiRegistry = component "KPI Registry" "【KPI 元数据】set_kpi、bursts、charter、burstRunHistory" "TypeScript" {
                    tags "Outer-Module" "KPI"
                    properties {
                        "path" "packages/server/src/outer/kpi-registry.ts"
                        "horizon.intention" "长期 KPI 元数据与 burst 关联"
                        "horizon.in" "set_kpi / attachBurst"
                        "horizon.out" "KpiRecord + burstRunHistory"
                        "horizon.test.integration" "kpiRegistry.component.integration.test.ts"
                    }
                }

                kpiManager = component "KPI Manager" "【KPI 治理】KPI 真相 + R3–R7 + burst 卫生；心跳 advance 降为兼容 fallback" "TypeScript" {
                    tags "Outer-Module" "KPI" "Heartbeat"
                    properties {
                        "path" "packages/server/src/outer/kpi/kpi-manager.ts"
                        "horizon.intention" "治理 KPI 生命周期；不独占空闲找活、日程或正常续派时钟"
                        "horizon.in" "EnvironmentSnapshot + kpiRegistry + innerBrainRegistry + SelfWork outcome"
                        "horizon.out" "reap/stop/pause/complete 治理；兼容 advance fallback"
                        "horizon.deps" "kpi-advancer; stale-burst-reaper; kpi-spawn-capacity; autonomy-policy; digitalEmployeeLoop"
                        "horizon.test.unit" "kpi-manager.test.ts"
                        "horizon.note" "见 KPI-MANAGER-LAYER.md + DIGITAL-EMPLOYEE-AUTONOMY.md"
                    }
                }

                kpiAdvancer = component "KPI Advancer" "【KPI burst 执行】advance_kpi / IM / Ops → set_goal(kpi_id)；心跳改由 kpiManager 调用" "TypeScript" {
                    tags "Outer-Module" "KPI" "Heartbeat"
                    properties {
                        "path" "packages/server/src/outer/kpi/kpi-advancer.ts"
                        "horizon.intention" "IM/Ops/兼容 heartbeat 的 KPI set_goal 执行器；正常续派由 digitalEmployeeLoop 触发"
                        "horizon.in" "kpiRegistry + innerBrainRegistry + (心跳) EnvironmentSnapshot.facets"
                        "horizon.out" "advanceKpi → outerToolExecutor set_goal"
                        "horizon.deps" "kpi-spawn-capacity; burstRunHistory; kpi-burst-state"
                        "horizon.test.unit" "kpi-advancer.test.ts"
                        "horizon.test.integration" "autonomy-heartbeat.component.integration.test.ts"
                        "horizon.note" "见 DIGITAL-EMPLOYEE-AUTONOMY.md；onExit scheduleNextKpiBurst 已删"
                    }
                }

                kpiFailureCircuit = component "KPI Failure Circuit" "【R7 路线级熔断】单路线连败 → blockedRoutes（KPI 保持 active）；多路线/无 goal 系统性 → pause + IM + action-log" "TypeScript" {
                    tags "Outer-Module" "KPI" "Heartbeat"
                    properties {
                        "path" "packages/server/src/outer/kpi/kpi-failure-circuit.ts"
                        "horizon.intention" "同路线三连败只停该路线换方向；系统性失败才暂停整个职责（DIGITAL-EMPLOYEE-AUTONOMY.md §6.3）"
                        "horizon.in" "kpiRegistry(active) + innerBrainRegistry burst goal/状态 + 阈值"
                        "horizon.out" "tripped[]（pause+IM）+ routeBlocked[]（kpi_route_circuit log）+ listBlockedRoutes → SelfWorkContext.blockedRoutes"
                        "horizon.deps" "kpi-burst-state.analyzeConsecutiveFailureRoutes; autonomy-action-log"
                        "horizon.test.unit" "kpi-failure-circuit.test.ts; kpi-burst-state.test.ts"
                        "horizon.note" "✅ P2；kpiManager.tick 每 tick 续派前调用；DEFAULT_MAX_CONSECUTIVE_FAILURES=3；窗口被 DONE/AWAITING 打断即自愈"
                    }
                }

                kpiCompletionJudge = component "KPI Completion Judge" "【KPI 完成判定】心跳 sweep + digest；suggestKpiAction=achieved → markAchieved" "TypeScript" {
                    tags "Outer-Module" "KPI" "Heartbeat"
                    properties {
                        "path" "packages/server/src/outer/kpi-completion-judge.ts"
                        "horizon.intention" "程序化 KPI 结案（onExit 不再 autoAchieve）"
                        "horizon.in" "kpiRegistry + innerBrainRegistry"
                        "horizon.out" "marked[] / pending[]; formatKpiCompletionBlock"
                        "horizon.deps" "kpi-progress; kpi-dispatch-guard"
                        "horizon.test.unit" "kpi-completion-judge.test.ts"
                        "horizon.note" "见 KPI-COMPLETION-JUDGE.md；outerHeartbeat 每 tick 调 sweep"
                    }
                }

                // ── 心跳 / 自主调度 ─────────────────────────────────────
                outerHeartbeat = component "Outer Heartbeat" "【Watchdog】质控+完成判定+死亡/失约检测+自主循环补漏；非正常续派主时钟" "TypeScript" {
                    tags "Outer-Module" "Autonomy" "Heartbeat"
                    properties {
                        "path" "packages/server/src/outer/outer-heartbeat.ts"
                        "horizon.intention" "经理巡检与漏事件恢复；正常工作交接由 digitalEmployeeLoop 事件驱动"
                        "horizon.in" "HeartbeatDeps + EnvironmentSnapshot + registry/KPI/Calendar trail"
                        "horizon.out" "oversight/reap/missed alert + heartbeat_fallback trigger + DEATH-DETECT"
                        "horizon.env" "UTLRA_OUTER_HEARTBEAT_INTERVAL_MS; UTLRA_OUTER_HEARTBEAT_ENABLED"
                        "horizon.test.integration" "outer-heartbeat.integration.test.ts; autonomy-heartbeat.component.integration.test.ts; outerHeartbeatDigitalEmployee.component.integration.test.ts"
                        "horizon.note" "见 OUTER-HEARTBEAT-OVERSIGHT.md + DIGITAL-EMPLOYEE-AUTONOMY.md"
                    }
                }

                digitalEmployeeLoop = component "Digital Employee Loop" "【容量驱动主循环】多触发 coalesce → 可用容量 → 到期日程优先 → 自主提案 → set_goal" "TypeScript" {
                    tags "Outer-Module" "Autonomy"
                    properties {
                        "path" "packages/server/src/outer/digital-employee-loop.ts; packages/server/src/outer/digital-employee-runtime.ts"
                        "horizon.intention" "数字员工一释放容量就找下一件有价值的工作；heartbeat 仅 fallback"
                        "horizon.in" "burst_finished/calendar_due/dependency_resolved/inbound_drained/policy_changed/heartbeat_fallback"
                        "horizon.out" "dispatch result / sleep reason / action-log"
                        "horizon.deps" "environmentModelFacade; autonomyJudge; employeeCalendar; selfWorkPolicy; outerToolExecutor"
                        "horizon.test.unit" "digital-employee-loop.test.ts"
                        "horizon.test.integration" "digitalEmployeeLoop.component.integration.test.ts"
                        "horizon.note" "✅ P1；runtime 接 burst/calendar/dependency/heartbeat；single-flight + coalesce + dispatch cap"
                    }
                }

                employeeCalendar = component "Employee Calendar" "【数字员工日程表】once/interval/cron 持久化承诺；due/missed；到期不占等待 worker" "TypeScript" {
                    tags "Outer-Module" "Autonomy" "Scheduler"
                    properties {
                        "path" "packages/server/src/scheduler/employee-calendar.ts; packages/server/src/openkuroneko/scheduled-tasks/"
                        "horizon.intention" "复用现有 Scheduler/TaskScheduler，统一业务日程真相；到期触发主循环"
                        "horizon.in" "CalendarCommitment CRUD + wall clock + capacity result"
                        "horizon.out" "calendar_due event + due/missed/status/history"
                        "horizon.deps" "TaskStore; CronParser; digitalEmployeeLoop; environmentSensorRegistry"
                        "horizon.test.unit" "task-scheduler.test.ts; employee-calendar.test.ts"
                        "horizon.test.integration" "digitalEmployeeLoop.component.integration.test.ts"
                        "horizon.note" "✅ P0/P1；missed 保持 due，由 polling event + heartbeat fallback 唤醒，不建立第二份 calendar store"
                    }
                }

                selfWorkPolicy = component "Self Work Policy" "【可测试创造性】4 策略角度轮询 + llm_reflective + AbTest 灰度 + 提案校验（去重/依赖/冲突/路线熔断）+ 指标 JSONL" "TypeScript" {
                    tags "Outer-Module" "Autonomy" "KPI"
                    properties {
                        "path" "packages/server/src/outer/self-work-policy.ts; packages/server/src/outer/self-work-strategies.ts; packages/server/src/outer/self-work-llm-policy.ts; packages/server/src/outer/self-work-metrics.ts"
                        "horizon.intention" "空闲容量的创造性找活；策略可注入/A-B；只有提案权"
                        "horizon.in" "active KPI + EnvironmentSnapshot + Calendar + pending dependencies + blockedRoutes + burst history"
                        "horizon.out" "SelfWorkProposal|null { action, expectedOutcome, reason, strategyId, conflictsWith } + self-work-metrics.jsonl"
                        "horizon.deps" "kpiRegistry; environmentModelFacade; employeeCalendar; innerBrainRegistry; kpiFailureCircuit.listBlockedRoutes; llm/raw"
                        "horizon.env" "UTLRA_SELF_WORK_STRATEGY"
                        "horizon.test.unit" "self-work-policy.test.ts; self-work-strategies.test.ts; self-work-llm-policy.test.ts; self-work-metrics.test.ts"
                        "horizon.test.integration" "digitalEmployeeLoop.component.integration.test.ts"
                        "horizon.note" "✅ P2/P3：deterministic 4 策略 + llm_reflective（JSON 契约 + fallback）+ ab: 灰度（探索满 minTrials 后按 acceptance rate 利用）；不能直接 spawn"
                    }
                }

                performanceGoalEngine = component "Performance Goal Engine" "【长期绩效目标】审阅 scorecard；心跳注入 performanceBlock" "TypeScript" {
                    tags "Outer-Module" "Autonomy" "KPI"
                    properties {
                        "path" "packages/server/src/performance-goals/engine.ts"
                        "horizon.intention" "自驱动绩效目标 LLM 审阅"
                        "horizon.in" "PerformanceGoalStore + mem9 context"
                        "horizon.out" "reviewGoalsForHeartbeat 文本块"
                        "horizon.test.unit" "performance-goals/*.test.ts"
                    }
                }

                llmUsageTracker = component "LLM Usage Tracker" "【LLM 计量】in-flight 计数 + usage 滚动窗口（prompt/completion tokens）" "TypeScript" {
                    tags "Outer-Module" "Autonomy"
                    properties {
                        "path" "packages/server/src/outer/llm-usage-tracker.ts"
                        "horizon.intention" "resourceProbe 的 token/并发数据源；完成时委托 journal 落盘"
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

                resourceProbe = component "Resource Probe" "【资源感知 P0 简版】扁平 ResourceSnapshot；P1 起被 environmentSensorRegistry 替代" "TypeScript" {
                    tags "Outer-Module" "Autonomy" "Transitional"
                    properties {
                        "path" "packages/server/src/outer/resource-probe.ts"
                        "horizon.intention" "心跳 tick 前只读采集系统负载（过渡期）"
                        "horizon.in" "innerBrainRegistry; llmUsageTracker; threadOrchestrator; participation-state"
                        "horizon.out" "ResourceSnapshot JSON"
                        "horizon.test.unit" "resource-probe.test.ts"
                        "horizon.note" "P1 起替换为 environmentSensorRegistry；见 ENVIRONMENT-MODEL.md"
                    }
                }

                // ── 环境模型（替代 resourceProbe） ────────────────────
                environmentSensorRegistry = component "Environment Sensor Registry" "【传感器注册表】tick 调度 + 扇入 facets → EnvironmentSnapshot；同 outerToolExecutor / autonomy handler 模式" "TypeScript" {
                    tags "Outer-Module" "Autonomy" "Environment"
                    properties {
                        "path" "packages/server/src/outer/environment/sensor-registry.ts; environment-sensors.ts"
                        "horizon.intention" "可插拔环境感知；新增维度=新增 handler，不动判定/策略组件"
                        "horizon.in" "EnvironmentSensor[] + SensorContext（注入只读 deps）"
                        "horizon.out" "EnvironmentSnapshot { facets: Record<id, FacetEnvelope> }"
                        "horizon.deps" "innerBrainRegistry; llmUsageJournal; threadOrchestrator; participation-state（经 ctx 注入）"
                        "horizon.test.unit" "environment-sensor-registry.test.ts"
                        "horizon.test.integration" "environmentSensorRegistry.component.integration.test.ts"
                        "horizon.note" "见 ENVIRONMENT-MODEL.md §3-§5；内置 sensor 列表 §8"
                    }
                }

                environmentJournal = component "Environment Journal" "【环境日志】内存 ring buffer + current.json 覆盖 + events.jsonl + hourly.jsonl（按月/年轮转）" "TypeScript" {
                    tags "Outer-Module" "Autonomy" "Environment" "Observability"
                    properties {
                        "path" "packages/server/src/outer/environment/journal.ts"
                        "horizon.intention" "三层时间尺度留存；环境模型记忆"
                        "horizon.in" "EnvironmentSnapshot（每 tick）+ EnvironmentEvent[]（事件驱动）"
                        "horizon.out" "ring buffer 读 + envEvents 查询（含未消费过滤）+ envHourly 聚合"
                        "horizon.test.unit" "environment-journal.test.ts"
                        "horizon.test.integration" "environmentJournal.component.integration.test.ts"
                        "horizon.note" "见 ENVIRONMENT-MODEL.md §6；DATA_ROOT/environment/"
                    }
                }

                environmentChangeDetector = component "Environment Change Detector" "【派生指标 + 显著事件】hysteresis / warmUp / rate / streak / zScore；deterministic" "TypeScript" {
                    tags "Outer-Module" "Autonomy" "Environment"
                    properties {
                        "path" "packages/server/src/outer/environment/change-detector.ts"
                        "horizon.intention" "把环境数据变成决策可读的诊断"
                        "horizon.in" "prev/next snapshot + sensor.detectEvents/derive"
                        "horizon.out" "FacetEnvelope.derived + EnvironmentEvent[]"
                        "horizon.test.unit" "environment-change-detector.test.ts"
                        "horizon.note" "禁止依赖 random/LLM；O(1) over ring buffer；见 ENVIRONMENT-MODEL.md §7"
                    }
                }

                environmentModelFacade = component "Environment Model Facade" "【环境模型门面】collectEnvironmentSnapshot / toResourceSnapshot / getSharedEnvironment" "TypeScript" {
                    tags "Outer-Module" "Autonomy" "Environment"
                    properties {
                        "path" "packages/server/src/outer/environment/index.ts"
                        "horizon.intention" "一次 tick 采集 + journal 留存；适配 legacy ResourceSnapshot"
                        "horizon.in" "CollectEnvironmentDeps + EnvironmentSensorRegistry + EnvironmentJournal"
                        "horizon.out" "EnvironmentSnapshot + toResourceSnapshot()"
                        "horizon.deps" "environmentSensorRegistry; environmentJournal"
                        "horizon.test.unit" "environment-sensor-registry.test.ts"
                        "horizon.note" "见 ENVIRONMENT-MODEL.md §2"
                    }
                }

                kpiSpawnCapacity = component "KPI Spawn Capacity" "【执行容量】读 EnvironmentSnapshot.facets + hardGates → canSpawn / hasAvailableCapacity（自适应前台预留）" "TypeScript" {
                    tags "Outer-Module" "Autonomy" "Environment" "KPI"
                    properties {
                        "path" "packages/server/src/outer/environment/kpi-spawn-capacity.ts"
                        "horizon.intention" "R6 环境 busy 时阻止 spawn；数字员工容量：前台活跃扣预留槽而非全停"
                        "horizon.in" "EnvironmentSnapshot.facets + AutonomyPolicy.hardGates(foregroundReserveSlots)"
                        "horizon.out" "KpiSpawnCapacity { canSpawn } + AvailableCapacity { available, freeInnerSlots, foregroundReservedSlots }"
                        "horizon.deps" "autonomyPolicyStore"
                        "horizon.test.unit" "kpi-spawn-capacity.test.ts"
                        "horizon.note" "✅ P3 前台预留（foreground_reserved / inbound_pressure）；blockIfOuterLoopActive 仅兼容 advance 路径；见 DIGITAL-EMPLOYEE-AUTONOMY.md §6.4"
                    }
                }

                staleBurstReaper = component "Stale Burst Reaper" "【逻辑并入 kpiManager】纯函数 selectStaleAwaiting + reap" "TypeScript" {
                    tags "Outer-Module" "KPI" "Inner-Lifecycle"
                    properties {
                        "path" "packages/server/src/outer/kpi/stale-burst-reaper.ts"
                        "horizon.intention" "R5 僵尸清理；由 kpiManager.reapStaleBursts 调用"
                        "horizon.test.unit" "stale-burst-reaper.test.ts"
                        "horizon.note" "见 KPI-MANAGER-LAYER.md §3.1 R5"
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

                nodeDefEviction = component "NodeDef Eviction" "【NodeDef 治理】心跳 sweep：dedupe + quota + cold tombstone；与 kpiCompletionJudge 同心跳级别" "TypeScript" {
                    tags "Outer-Module" "Heartbeat" "DyFlow-Lifecycle"
                    properties {
                        "path" "packages/server/src/outer/node-def-eviction.ts"
                        "horizon.intention" "防 NodeDef 爆炸；importCount/citeCount/age 评分 + 配额 + tombstone（不删原文）"
                        "horizon.in" "nodeDefDrive9Store.index + 配额（maxActive，默认 200）"
                        "horizon.out" "tombstone marks（cold + quota 两类）"
                        "horizon.deps" "nodeDefDrive9Store"
                        "horizon.test.unit" "node-def-eviction.test.ts"
                        "horizon.note" "scoreEntry + runNodeDefEviction：cold(importCount==0 && ageDays>coldDays) → quota(按 score 升序至 floor(max*(1-headroom)))；见 INNER-NODE-LIFECYCLE.md §7"
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

                workflowEvolutionPolicy = component "Workflow Evolution Policy" "【✅】质检失败 → ew_revision 提案；SelfWork 优先 explore" "TypeScript" {
                    tags "Outer-Module" "Executable-Workflow" "Digital-Employee"
                    properties {
                        "path" "packages/server/src/outer/workflow-evolution-policy.ts"
                        "horizon.intention" "Agent 自优化 EW：只提案不写契约"
                        "horizon.in" "outcome · kpiId · workflowRef"
                        "horizon.out" "pending evolution → SelfWork explore set_goal"
                        "horizon.deps" "workflowEvolutionStore；selfWorkPolicy；set_goal"
                        "horizon.test.unit" "workflow-evolution-policy.test.ts"
                        "horizon.note" "日历硬闸不挡 ew_revision；见 DIGITAL-EMPLOYEE-AUTONOMY.md"
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

                autonomyPolicyStore = component "Autonomy Policy Store" "【闲忙规则】policy.json + policy-rubric.md；聊天 tools 可改" "TypeScript" {
                    tags "Outer-Module" "Autonomy" "Environment"
                    properties {
                        "path" "packages/server/src/outer/environment/autonomy-policy-store.ts"
                        "horizon.intention" "可配置 hardGates + 自然语言 rubric"
                        "horizon.in" "read / patch / replace rubric"
                        "horizon.out" "AutonomyPolicy"
                        "horizon.deps" "outerToolExecutor(memory_block 同构 CRUD)"
                        "horizon.test.unit" "autonomy-policy-store.test.ts"
                        "horizon.note" "shim: outer/autonomy-policy-store.ts re-export"
                    }
                }

                autonomyJudge = component "Autonomy Judge" "【容量判定】hard gates → hasAvailableCapacity；等待依赖不等于 RUNNING" "TypeScript" {
                    tags "Outer-Module" "Autonomy" "Environment"
                    properties {
                        "path" "packages/server/src/outer/environment/autonomy-judge.ts"
                        "horizon.intention" "环境快照 + hardGates 判断剩余执行容量；前台预留而非无条件全停"
                        "horizon.in" "ResourceSnapshot + AutonomyPolicy"
                        "horizon.out" "CapacityVerdict(hasAvailableCapacity/freeInnerSlots/blockedByHardGate)"
                        "horizon.deps" "autonomyPolicyStore; environmentSensorRegistry"
                        "horizon.test.unit" "autonomy-judge.test.ts"
                        "horizon.note" "兼容期仍输出 idle|busy；目标语义见 ENVIRONMENT-MODEL.md §9.1 + DIGITAL-EMPLOYEE-AUTONOMY.md"
                    }
                }

                agentPersonality = component "Agent Personality" "【性格参数】personality.json：idleChatProbability 等；与 soul.md 并列" "TypeScript" {
                    tags "Outer-Module" "Autonomy" "Conversation"
                    properties {
                        "path" "packages/server/src/outer/personality.ts"
                        "horizon.intention" "定时器闲聊分支 Bernoulli 概率 p；各 agent DATA_ROOT 独立"
                        "horizon.in" "read / patch personality.json"
                        "horizon.out" "AgentPersonality"
                        "horizon.deps" "soul.md 同目录 outer/；outerToolExecutor update_personality"
                        "horizon.test.unit" "personality.test.ts"
                        "horizon.note" "见 RESOURCE-AWARENESS-AUTONOMY.md §6.2"
                    }
                }

                casualChatDispatcher = component "Casual Chat Dispatcher" "【idle 闲聊】性格概率 proactive IM；KPI spawn 由 kpiManager 负责" "TypeScript" {
                    tags "Outer-Module" "Autonomy"
                    properties {
                        "path" "packages/server/src/outer/casual-chat-dispatcher.ts"
                        "horizon.intention" "verdict=idle 且无 KPI 相关 burst 在途 → 按 idleChatProbability 起草并 post_to_im"
                        "horizon.in" "AutonomyVerdict(idle) + policy + personality + kpiRegistry（仅 defer 判定）"
                        "horizon.out" "post_to_im + action-log"
                        "horizon.deps" "participationPolicy; agentPersonality; kpiRegistry; imClient"
                        "horizon.test.unit" "casual-chat-dispatcher.test.ts"
                        "horizon.note" "见 RESOURCE-AWARENESS-AUTONOMY.md §8.3；KPI 派遣见 KPI-MANAGER-LAYER.md"
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

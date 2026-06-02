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

                outerBrainFacade = component "Outer Brain Facade" "【IM 主入口】Discord/WebChat 入站 → 检索 → 是否说话 → 外脑对话环" "TypeScript" {
                    tags "Outer-Module" "Inbound"
                    properties {
                        "path" "packages/server/src/outer/outer-brain.ts"
                        "horizon.intention" "渠道入站编排（非 HTTP roundtrip）"
                        "horizon.in" "ChatIRInboundEvent"
                        "horizon.out" "调用 knowledge / policy / conversationLoop"
                        "entry" "channel.onInbound"
                        "horizon.test.integration" "outerBrainFacade.component.integration.test.ts; outer-brain-inbound.integration.test.ts; outer-brain-channel-wire.integration.test.ts"
                    }
                }

                outerOrchestrator = component "Outer Orchestrator" "【HTTP roundtrip 入口】写 thread/goal → 参与决策 → 可选 spawn burst → 拼 StructuredReply" "TypeScript" {
                    tags "Outer-Module" "Inbound"
                    properties {
                        "path" "packages/server/src/outer/orchestrator.ts"
                        "horizon.intention" "M6 一次性 roundtrip（API/调试）"
                        "horizon.in" "POST /api/outer/roundtrip 参数"
                        "horizon.out" "StructuredReply + worker 状态"
                        "horizon.deps" "participationPolicy; innerSpawner（直 spawn，不经 registry）"
                        "entry" "runOuterRoundtrip"
                        "horizon.test.integration" "outerOrchestrator.component.integration.test.ts; outer-roundtrip.integration.test.ts; outer-roundtrip-inner.integration.test.ts"
                    }
                }

                knowledgeRetrieval = component "Knowledge Retrieval" "【上下文检索】本地 repository K/S/P + 本线程/跨线程历史 → 注入 LLM 前缀" "TypeScript" {
                    tags "Outer-Module" "Inbound"
                    properties {
                        "path" "packages/server/src/outer/knowledge-retrieval.ts"
                        "horizon.intention" "拼 knowledgeContext 字符串"
                        "horizon.in" "query + threadId + workspaceId"
                        "horizon.out" "context + sources 统计"
                        "horizon.deps" "FilesystemRepositoryStore + chat-ir；禁止 mem9/drive9"
                        "horizon.test.integration" "knowledgeRetrieval.component.integration.test.ts"
                    }
                }

                outerMemory = component "Outer Memory" "【外脑记忆】daily-log / tasks → mem9；拼到 knowledge 前" "TypeScript" {
                    tags "Outer-Module" "Inbound"
                    properties {
                        "path" "packages/server/src/outer/outer-memory.ts"
                        "horizon.intention" "长期任务与日志上下文"
                        "horizon.in" "mem9 read"
                        "horizon.out" "formatMemoryForLlm 文本块"
                        "horizon.deps" "mem9-client + drive9-client（本模块为唯一外脑门面）"
                        "horizon.test.unit" "memory-belief-reconcile.test.ts"
                        "horizon.test.integration" "outerMemory.component.integration.test.ts"
                        "horizon.note" "MVP：用户取消/完成 → belief 对账 + tasks 降权"
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
                outerConversationLoop = component "Outer Conversation Loop" "【外脑多轮】LLM ↔ tools 循环直到 reply_to_user 或达上限" "TypeScript" {
                    tags "Outer-Module" "Conversation"
                    properties {
                        "path" "packages/server/src/outer/outer-conversation-loop.ts"
                        "horizon.intention" "外脑 ReAct 环"
                        "horizon.in" "userMessage + knowledgeContext + soul"
                        "horizon.out" "tool_calls 或最终回复"
                        "horizon.test.integration" "outerConversationLoop.component.integration.test.ts; outer-conversation-loop-assembly.integration.test.ts"
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
                innerBrainRegistry = component "Inner Brain Registry" "【任务表】instanceId、RUNNING/DONE/BLOCK/AWAITING、workDir、KPI 关联；持久化 inner-brain-registry.json" "TypeScript" {
                    tags "Outer-Module" "Inner-Lifecycle" "KPI"
                    properties {
                        "path" "packages/server/src/outer/inner-brain-registry.ts"
                        "horizon.intention" "burst 实例状态机（磁盘 JSON）；外脑重启时识别 RUNNING 僵尸行"
                        "horizon.in" "register / update / list"
                        "horizon.out" "TaskRecord; markStaleRunningAsStopped()"
                        "horizon.test.unit" "inner-brain-registry.test.ts"
                        "horizon.test.integration" "innerBrainRegistry.component.integration.test.ts"
                        "horizon.note" "KPI 模式：同一 kpiId 仅一个 canonical TaskRecord 活跃；续跑 update 而非 register 新行"
                    }
                }

                innerBrainKpiReuse = component "Inner Brain KPI Reuse" "【KPI 单实例】findCanonicalBurstForKpi；set_goal/schedule 续跑同一 workDir；禁止同 KPI 多 workspace" "TypeScript" {
                    tags "Outer-Module" "Inner-Lifecycle" "KPI"
                    properties {
                        "path" "packages/server/src/outer/inner-brain-kpi-reuse.ts; outer/kpi-dispatch-guard.ts"
                        "horizon.intention" "同一长期目标一个内脑；每轮 EXECUTE 小步前进 + 修正计划"
                        "horizon.in" "kpiId + innerBrainRegistry + kpiRegistry"
                        "horizon.out" "canonical TaskRecord; patch goal.md; isSetGoalDispatched"
                        "horizon.deps" "innerBrainRegistry; kpiRegistry; innerSpawner（caller: outerToolExecutor / index schedule*）"
                        "horizon.test.unit" "inner-brain-kpi-reuse.test.ts; kpi-dispatch-guard.test.ts"
                        "horizon.note" "权威规则见 INNER-BRAIN-SINGLE-INSTANCE.md §2 R1–R5"
                    }
                }

                workspaceInbox = component "Workspace Inbox" "【同 KPI 互读】collectPeerWorkspaceIds + writePeerCatalog（名字/摘要）；spawn 注入 INNER_PEER_WORKSPACE_IDS" "TypeScript" {
                    tags "Outer-Module" "Inner-Lifecycle" "KPI"
                    properties {
                        "path" "packages/server/src/outer/workspace-inbox.ts"
                        "horizon.intention" "同 KPI sibling workspace 完全互读；spawn 只写 .inbox/ 目录，不传正文"
                        "horizon.in" "innerBrainRegistry + kpiRegistry + explicit peer_workspace_ids"
                        "horizon.out" ".inbox/catalog.json + README.md; peer id 列表 → innerSpawner env"
                        "horizon.deps" "innerBrainRegistry; kpiRegistry; outerToolExecutor(set_goal); index spawnAndAttachWorker(resume)"
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
                        "horizon.note" "resume/restart：index spawnAndAttachWorker 亦经 workspaceInbox 刷新 peer+catalog"
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

                registryLifecycleReconcile = component "Registry Lifecycle Reconcile" "【registry↔workDir 对账】AWAITING/BLOCKED 假挂起→DONE；启动时 + changeWatcher.bootstrap" "TypeScript" {
                    tags "Outer-Module" "Inner-Lifecycle"
                    properties {
                        "path" "packages/server/src/outer/registry-lifecycle-reconcile.ts"
                        "horizon.intention" "消除 is_post_complete 时 registry 仍为 AWAITING"
                        "horizon.in" "innerBrainRegistry + brainAsyncSnapshot"
                        "horizon.out" "registry.update(DONE|保持)"
                        "horizon.test.unit" "registry-lifecycle-reconcile.test.ts"
                        "horizon.test.integration" "registryLifecycleReconcile.component.integration.test.ts"
                        "horizon.note" "见 INNER-BRAIN-AWAITING-LIFECYCLE.md"
                    }
                }

                awaitingInboundResolver = component "Awaiting Inbound Resolver" "【IM 必达】人消息 → 同 thread 的 ask_user pending → resolved；spawn 仍由 changeWatcher" "TypeScript" {
                    tags "Outer-Module" "Inbound" "Inner-Lifecycle"
                    properties {
                        "path" "packages/server/src/outer/awaiting-inbound-resolver.ts"
                        "horizon.intention" "宪法 IMWatcher 的确定性实现；不依赖 LLM 调 send_directive"
                        "horizon.in" "ChatIRInboundEvent(human) + innerBrainRegistry"
                        "horizon.out" "resolvePending on workDir"
                        "horizon.deps" "brainAsyncSnapshot; innerBrainRegistry"
                        "horizon.test.unit" "awaiting-inbound-resolver.test.ts"
                        "horizon.test.integration" "awaitingInboundResolver.component.integration.test.ts"
                        "horizon.note" "挂载于 outerBrainFacade，policy 之后、conversationLoop 之前"
                    }
                }

                innerBrainStartupResume = component "Inner Brain Startup Resume" "【外脑重启恢复】启动时扫 registry 里 RUNNING→子进程已死→markStale→spawn 同一 instance；与 AWAITING 专篇互补" "TypeScript" {
                    tags "Outer-Module" "Inner-Lifecycle"
                    properties {
                        "path" "packages/server/src/outer/inner-brain-startup-resume.ts"
                        "horizon.intention" "外脑进程重启不中断「执行中」的内脑 burst"
                        "horizon.in" "inner-brain-registry.json 中 status=RUNNING"
                        "horizon.out" "spawnAndAttachWorker(同一 workDir)"
                        "horizon.env" "UTLRA_INNER_AUTO_RESUME(默认1); UTLRA_INNER_MAX_AUTO_RESUME(默认3)"
                        "horizon.test.unit" "inner-brain-startup-resume.test.ts; inner-brain-registry.test.ts"
                        "horizon.test.integration" "innerBrainStartupResume.component.integration.test.ts"
                        "horizon.note" "手动恢复: POST /api/inner-brains/:id/restart 不占 resumeCount"
                    }
                }

                completionNotify = component "Completion Notify" "【完成通知】burst DONE → buildCompletionReport(audience=im) → 附件 parts；与 pushLoop 分工（COMPLETE 不重复推）" "TypeScript" {
                    tags "Outer-Module" "Inner-Lifecycle"
                    properties {
                        "path" "packages/server/src/outer/completion-notify.ts; openkuroneko/burst/completion-report.ts"
                        "horizon.intention" "onExit 主路径：结果摘要 + 产出附件，不堆 milestones/reflexion 过程"
                        "horizon.in" "TaskRecord + workDir(.brain + deliverables + output COMPLETE)"
                        "horizon.out" "postMessage(text≤3.2k + attachment parts); outerMemory 用 audience=verbose"
                        "horizon.protocol" "doc/protocols/inner-brain-deliverables.md §6.4"
                        "horizon.test.unit" "completion-notify.test.ts; completion-report.test.ts"
                        "horizon.test.integration" "completionNotify.component.integration.test.ts"
                    }
                }

                pushLoop = component "Push Loop" "【增量推送】轮询 RUNNING 实例的 .run/pi-mono/output；PROGRESS/BLOCK 推渠道" "TypeScript" {
                    tags "Outer-Module" "Inner-Lifecycle"
                    properties {
                        "path" "packages/server/src/outer/push-loop.ts"
                        "horizon.intention" "长任务中途进度（COMPLETE 主要由 onExit）"
                        "horizon.in" "registry 列表 + offset 文件"
                        "horizon.out" "imClient.postMessage"
                        "horizon.test.integration" "pushLoop.component.integration.test.ts"
                    }
                }

                changeWatcher = component "Change Watcher" "【AWAITING 唤醒】bootstrap(reconcile+timer 补单) + 1s tick：unconsumed resolved → spawn；不负责 IM 入站" "TypeScript" {
                    tags "Outer-Module" "Inner-Lifecycle"
                    properties {
                        "path" "packages/server/src/pi-mono/change-watcher.ts"
                        "horizon.intention" "pendings 到期/解封后 spawn；与 registryLifecycleReconcile / awaitingInboundResolver 分工"
                        "horizon.in" "innerBrainRegistry AWAITING|BLOCKED 列表"
                        "horizon.out" "innerSpawner spawn"
                        "horizon.test.unit" "change-watcher.test.ts"
                        "horizon.test.integration" "changeWatcher.component.integration.test.ts; await-and-wake.integration.test.ts"
                        "horizon.note" "v1 为 poll 非最小堆；见 INNER-BRAIN-AWAITING-LIFECYCLE.md §5.3"
                    }
                }

                // ── KPI ─────────────────────────────────────────────────
                kpiRegistry = component "KPI Registry" "【KPI 元数据】set_kpi、反思 trail、idle streak、调度 meta burst" "TypeScript" {
                    tags "Outer-Module" "KPI"
                    properties {
                        "path" "packages/server/src/outer/kpi-registry.ts"
                        "horizon.intention" "长期指标与反思链"
                        "horizon.in" "set_kpi / attachBurst"
                        "horizon.out" "KpiRecord + reflexionTrail"
                        "horizon.test.integration" "kpiRegistry.component.integration.test.ts"
                    }
                }

                kpiBurstHooks = component "KPI Burst Hooks" "【burst 退出】读 reflexion.json → trail/idle；streak≥阈值 → meta 周期；AUTO_NEXT → 续跑 canonical 真任务" "TypeScript" {
                    tags "Outer-Module" "KPI"
                    properties {
                        "path" "packages/server/src/outer/kpi-burst-hooks.ts"
                        "horizon.intention" "把一次 EXECUTE 周期结果写回 KPI 并闭合调度环"
                        "horizon.in" "workDir + stoppedBy + isReflexionBurst + isAwaiting"
                        "horizon.out" "reflexionTrail / idleStreak / scheduleReflexionBurst / scheduleNextKpiBurst"
                        "horizon.deps" "innerBrainKpiReuse（index.ts schedule* 复用 canonical spawn）"
                        "horizon.test.unit" "kpi-burst-hooks.test.ts"
                        "horizon.test.integration" "kpiBurstHooks.component.integration.test.ts; kpi-lifecycle.integration.test.ts"
                        "horizon.note" "schedule* 不 generateInstanceId；见 INNER-BRAIN-SINGLE-INSTANCE.md"
                    }
                }

                kpiCompletionJudge = component "KPI Completion Judge" "【KPI 完成判定】心跳 sweep + digest；suggestKpiAction=achieved → markAchieved" "TypeScript" {
                    tags "Outer-Module" "KPI" "Heartbeat"
                    properties {
                        "path" "packages/server/src/outer/kpi-completion-judge.ts"
                        "horizon.intention" "程序化 KPI 结案；与 kpiBurstHooks onExit autoAchieved 同规则"
                        "horizon.in" "kpiRegistry + innerBrainRegistry"
                        "horizon.out" "marked[] / pending[]; formatKpiCompletionBlock"
                        "horizon.deps" "kpi-progress; kpi-dispatch-guard"
                        "horizon.test.unit" "kpi-completion-judge.test.ts"
                        "horizon.note" "见 KPI-COMPLETION-JUDGE.md；outerHeartbeat 每 tick 调 sweep"
                    }
                }

                // ── 心跳 / 自主调度 ─────────────────────────────────────
                outerHeartbeat = component "Outer Heartbeat" "【定时心跳】战略+质控+KPI完成判定+死亡检测+自主调度" "TypeScript" {
                    tags "Outer-Module" "Autonomy" "Heartbeat"
                    properties {
                        "path" "packages/server/src/outer/outer-heartbeat.ts"
                        "horizon.intention" "tick 编排：战略 WHY+HOW → 质控 → dispatch；死亡检测"
                        "horizon.in" "HeartbeatDeps + LLM env + registry/KPI trail + strategyStore"
                        "horizon.out" "post_to_im / set_goal / autonomy dispatch / DEATH-DETECT"
                        "horizon.env" "UTLRA_OUTER_HEARTBEAT_INTERVAL_MS; UTLRA_OUTER_HEARTBEAT_ENABLED"
                        "horizon.test.integration" "outer-heartbeat.integration.test.ts; autonomy-heartbeat.component.integration.test.ts"
                        "horizon.note" "战略 STRATEGY-PLANNING-LAYER.md；质控 OUTER-HEARTBEAT-OVERSIGHT.md；调度 RESOURCE-AWARENESS-AUTONOMY.md"
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

                // ── 战略规划层 ─────────────────────────────────────────
                strategyStore = component "Strategy Store" "【战略真相】current.json + journal.jsonl；唯一写权 strategyPlanner" "TypeScript" {
                    tags "Outer-Module" "Autonomy" "Strategy"
                    properties {
                        "path" "packages/server/src/outer/strategy/strategy-store.ts"
                        "horizon.intention" "战略文件持久化；只读消费方众多"
                        "horizon.in" "StrategyArtifact write / read / journal append"
                        "horizon.out" "StrategyArtifact + journal 摘要"
                        "horizon.test.unit" "strategy-store.test.ts"
                        "horizon.note" "DATA_ROOT/strategy/；见 STRATEGY-PLANNING-LAYER.md §5,§11"
                    }
                }

                strategyPlanner = component "Strategy Planner" "【REFLECT+DESIGN】跨 KPI 宏观战略：WHY（信念/取舍）+ HOW（focusOrder/角度）；事件驱动重评估" "TypeScript" {
                    tags "Outer-Module" "Autonomy" "Strategy"
                    properties {
                        "path" "packages/server/src/outer/strategy/strategy-planner.ts"
                        "horizon.intention" "WHY+HOW 投影为 StrategyArtifact；不受 burst 质控层替代"
                        "horizon.in" "StrategyReflectInput（env current/events/hourly + kpis + reflexionTrail + recentBursts + lastStrategy）"
                        "horizon.out" "StrategyArtifact（theory/whyNow + focusOrder + cullDirectives + reEvaluateAfter）"
                        "horizon.deps" "llmGateway; environmentJournal; strategyStore; kpiRegistry; performanceGoalEngine"
                        "horizon.test.integration" "strategyPlanner.component.integration.test.ts"
                        "horizon.test.prompt" "strategy-planner.prompt.test.ts"
                        "horizon.note" "P0 单 LLM call 仍须 WHY+HOW 两段；见 STRATEGY-PLANNING-LAYER.md §2b,§6,§7"
                    }
                }

                staleBurstReaper = component "Stale Burst Reaper" "【杀僵尸】执行 strategy.cullDirectives + maxAwaitingMs 静态兜底；ABORTED 状态迁移 + archive" "TypeScript" {
                    tags "Outer-Module" "Autonomy" "Strategy" "Inner-Lifecycle"
                    properties {
                        "path" "packages/server/src/outer/strategy/stale-burst-reaper.ts"
                        "horizon.intention" "解决「该死怎么死」；与 awaitingInboundResolver/registryLifecycleReconcile 互补"
                        "horizon.in" "StrategyArtifact + innerBrainRegistry + awaitingInboundResolver.peek"
                        "horizon.out" "ABORTED registry rows + archive sessions + action-log"
                        "horizon.deps" "innerBrainRegistry; awaitingInboundResolver; archiveStore（内脑产出）"
                        "horizon.test.unit" "stale-burst-reaper.test.ts"
                        "horizon.test.integration" "staleBurstReaper.component.integration.test.ts"
                        "horizon.note" "杀=状态迁移+archive，禁 rm；见 STRATEGY-PLANNING-LAYER.md §9"
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
                        "horizon.note" "schema 见 INNER-NODE-LIFECYCLE.md §5.4"
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

                autonomyPolicyStore = component "Autonomy Policy Store" "【闲忙规则】policy.json + policy-rubric.md；聊天 tools 可改" "TypeScript" {
                    tags "Outer-Module" "Autonomy"
                    properties {
                        "path" "packages/server/src/outer/autonomy-policy-store.ts"
                        "horizon.intention" "可配置 hardGates + 自然语言 rubric"
                        "horizon.in" "read / patch / replace rubric"
                        "horizon.out" "AutonomyPolicy"
                        "horizon.deps" "outerToolExecutor(memory_block 同构 CRUD)"
                        "horizon.test.unit" "autonomy-policy-store.test.ts"
                    }
                }

                autonomyJudge = component "Autonomy Judge" "【闲忙判定】P0 仅 hard gates → idle|busy；P2 可选 rubric LLM；P1 起读 EnvironmentSnapshot 派生量" "TypeScript" {
                    tags "Outer-Module" "Autonomy"
                    properties {
                        "path" "packages/server/src/outer/autonomy-judge.ts"
                        "horizon.intention" "环境快照 + policy.hardGates 同步判定是否可 dispatch"
                        "horizon.in" "EnvironmentSnapshot（P1 起；P0 仍读 ResourceSnapshot）+ AutonomyPolicy"
                        "horizon.out" "AutonomyVerdict(idle|busy)"
                        "horizon.deps" "autonomyPolicyStore; environmentSensorRegistry（P1）"
                        "horizon.test.unit" "autonomy-judge.test.ts"
                        "horizon.note" "P0 不调 LLM；rate/streak hardGate 见 ENVIRONMENT-MODEL.md §9.1"
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

                autonomyTaskDispatcher = component "Autonomy Task Dispatcher" "【自主任务】P0 KPI 优先 spawn / 性格概率闲聊；P1 起退化为按 strategy.focusOrder 派遣（不再自由选 KPI）" "TypeScript" {
                    tags "Outer-Module" "Autonomy"
                    properties {
                        "path" "packages/server/src/outer/autonomy-task-dispatcher.ts"
                        "horizon.intention" "P0 阶梯：hasKpi&&canSpawn→kpi_inner_goal；否则 random<p→casual_chat。P1 后：读 strategyStore.current → 按 focusOrder 挑首个可推 KPI"
                        "horizon.in" "AutonomyVerdict(idle) + policy + personality + (P0)kpiRegistry / (P1)strategyStore"
                        "horizon.out" "post_to_im / set_goal + action-log"
                        "horizon.deps" "outerToolExecutor; participationPolicy; agentPersonality; (P0)kpiRegistry; (P1)strategyStore"
                        "horizon.test.integration" "autonomy-heartbeat.component.integration.test.ts"
                        "horizon.note" "P0 见 RESOURCE-AWARENESS-AUTONOMY.md §8.3；P1 退化形态见 STRATEGY-PLANNING-LAYER.md §10"
                    }
                }

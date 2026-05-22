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

                threadOrchestrator = component "Thread Orchestrator" "【线程新鲜度】反 agent 自循环、触发消息是否仍最新；供对话环中止" "TypeScript" {
                    tags "Outer-Module" "Inbound"
                    properties {
                        "path" "packages/server/src/outer/thread-orchestrator.ts"
                        "horizon.intention" "防止过时消息继续驱动 LLM"
                        "horizon.in" "seenTracker + threadId + triggerMessageId"
                        "horizon.out" "freshCheck 回调"
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
                        "horizon.test.integration" "outerMemory.component.integration.test.ts"
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

                outerToolExecutor = component "Outer Tool Executor" "【工具执行】reply_to_user / set_goal / list_brains / read_inner_status / KPI 等" "TypeScript" {
                    tags "Outer-Module" "Conversation"
                    properties {
                        "path" "packages/server/src/outer/outer-tools.ts"
                        "horizon.intention" "执行 LLM 返回的每个 tool_call"
                        "horizon.in" "tool name + args"
                        "horizon.out" "渠道 postMessage；spawn；registry 更新"
                        "horizon.test.integration" "outerToolExecutor.component.integration.test.ts"
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
                innerBrainRegistry = component "Inner Brain Registry" "【任务表】instanceId、RUNNING/DONE/BLOCK/AWAITING、workDir、KPI 关联" "TypeScript" {
                    tags "Outer-Module" "Inner-Lifecycle"
                    properties {
                        "path" "packages/server/src/outer/inner-brain-registry.ts"
                        "horizon.intention" "多 burst 实例状态机（磁盘 JSON）"
                        "horizon.in" "register / update / list"
                        "horizon.out" "TaskRecord"
                        "horizon.test.integration" "innerBrainRegistry.component.integration.test.ts"
                    }
                }

                innerSpawner = component "Inner Spawner" "【子进程】spawn inner-brain-worker；env 传 workDir；onExit 回调" "TypeScript" {
                    tags "Outer-Module" "Inner-Lifecycle"
                    properties {
                        "path" "packages/server/src/pi-mono/inner-brain-spawner.ts"
                        "horizon.intention" "进程级隔离内脑"
                        "horizon.in" "instanceId + workDir + maxTicks"
                        "horizon.out" "pid + status 文件"
                        "horizon.test.integration" "innerSpawner.component.integration.test.ts; spawn-inner-worker-live.integration.test.ts"
                    }
                }

                completionNotify = component "Completion Notify" "【完成通知】burst DONE → 产物 ingest → 用户 IM 消息（与 pushLoop 分工）" "TypeScript" {
                    tags "Outer-Module" "Inner-Lifecycle"
                    properties {
                        "path" "packages/server/src/outer/completion-notify.ts"
                        "horizon.intention" "onExit 主路径通知用户"
                        "horizon.in" "TaskRecord + workerStatus"
                        "horizon.out" "postMessage + deliverables"
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

                changeWatcher = component "Change Watcher" "【AWAITING 唤醒】轮询 pendings.json，到期/解封后 spawn 新 burst" "TypeScript" {
                    tags "Outer-Module" "Inner-Lifecycle"
                    properties {
                        "path" "packages/server/src/pi-mono/change-watcher.ts"
                        "horizon.intention" "数据驱动重跑（timer/deadline/resolved pending）"
                        "horizon.in" "innerBrainRegistry AWAITING 列表"
                        "horizon.out" "innerSpawner spawn"
                        "horizon.test.unit" "change-watcher.test.ts"
                        "horizon.test.integration" "changeWatcher.component.integration.test.ts; await-and-wake.integration.test.ts"
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

                kpiBurstHooks = component "KPI Burst Hooks" "【burst 退出】读 reflexion.json → trail/idle；streak≥阈值 → meta burst；AUTO_NEXT → 下一发真任务" "TypeScript" {
                    tags "Outer-Module" "KPI"
                    properties {
                        "path" "packages/server/src/outer/kpi-burst-hooks.ts"
                        "horizon.intention" "把一次 burst 结果写回 KPI 语义并闭合调度环"
                        "horizon.in" "workDir + stoppedBy + isReflexionBurst + isAwaiting"
                        "horizon.out" "reflexionTrail / idleStreak / scheduleReflexionBurst / scheduleNextKpiBurst"
                        "horizon.test.unit" "kpi-burst-hooks.test.ts"
                        "horizon.test.integration" "kpiBurstHooks.component.integration.test.ts; kpi-lifecycle.integration.test.ts"
                    }
                }

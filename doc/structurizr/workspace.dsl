workspace "Kuroneko" "ADL authority: L1-L2 integration + L3 agentServer modules. Horizon props: horizon.intention|in|out|deps. Tags: http|ws|spawn|file|import." {

    !identifiers hierarchical

    model {
        user = person "用户" "仅经 IM 渠道对话与派任务；不直连 Agent API"

        operator = person "运维/观察者" "ops-console、performance dashboard；查看内外脑与 KPI"

        discord = softwareSystem "Discord" "外部 IM（Gateway + REST）" {
            tags "External" "IM-Interface"
        }

        localWebChatIm = softwareSystem "本地 WebChat IM" "apps/chat-server REST/WS 枢纽 + web-chat 浏览器；自建对话入口" {
            tags "IM-Interface"
            properties {
                "realizedBy" "kuroneko.chatServer + kuroneko.webChat"
                "path" "apps/chat-server; apps/web-chat"
            }
        }

        brainMonitoring = softwareSystem "内外脑监控" "ops-console 启停与 KPI 调试 + dashboard 性能/目标面板" {
            tags "Monitoring"
            properties {
                "path" "apps/ops-console; apps/dashboard"
                "horizon.intention" "观察外脑/内脑状态，非终端用户对话"
            }
        }
        llm = softwareSystem "LLM 提供商" "Zhipu / LocalModule 等" {
            tags "External"
        }
        mem9 = softwareSystem "mem9" "对话与任务云记忆" {
            tags "External"
        }
        drive9 = softwareSystem "drive9" "技能 / 知识 Markdown + grep" {
            tags "External"
        }

        kuroneko = softwareSystem "Kuroneko (utlra)" "多通道 Agent：外脑编排、内脑子进程、技能与记忆" {
            !docs docs
            !adrs decisions

            // ── L2 共享库（npm 包，非独立进程）────────────────────
            chatIrLib = container "Chat IR" "消息/线程 schema、ChatIRChannel、ChatIRSeenTracker（mention 感知 freshCheck）、StructuredReply" "npm @utlra/chat-ir" {
                tags "Library"
                properties {
                    "path" "packages/chat-ir"
                    "horizon.intention" "渠道无关聊天中间表示 + 运行时观察（反 loop / 抢答）"
                    "horizon.in" "Channel track/postMessage；mention parts"
                    "horizon.out" "类型契约；hasAnotherAgentRepliedAfter（独占@不互掐）"
                    "horizon.deps" "无 kuroneko 业务包"
                    "horizon.test.unit" "packages/chat-ir/src/seen-tracker.test.ts"
                }
            }

            workspaceKit = container "Workspace Kit" "外脑侧 workDir 工具：路径安全读写、manifest、InnerBrainEngine 生命周期门面（内联于 @utlra/server）" "TypeScript packages/server/src/workspace-kit" {
                tags "Library" "Toolkit"
                properties {
                    "path" "packages/server/src/workspace-kit"
                    "naming.note" "P3a：原 @utlra/core 已内联；非可复用领域核心"
                    "horizon.intention" "定义 workDir/.run 布局；外脑 spawn/shutdown/reset；与内脑共享磁盘契约"
                    "horizon.in" "仅 agentServer 进程 npm import"
                    "horizon.out" "FilesystemWorkspaceStore、InnerBrainEngine、本地 repository 检索"
                    "horizon.deps" "innerWorker 同 workDir（file 边，子进程不 import 本包）"
                    "not" "openkuroneko 阶段机、ChatIR、LLM"
                }
            }

            webchatProtocolLib = container "WebChat Protocol" "chat-server 与 agent 共享协议类型" "npm @utlra/webchat-protocol" {
                tags "Library"
                properties {
                    "path" "packages/webchat-protocol"
                    "horizon.intention" "WebChat 协议 DTO"
                    "horizon.in" "序列化/反序列化"
                    "horizon.out" "协议对象"
                    "horizon.deps" "无"
                }
            }

            // ── L2 可部署单元 ─────────────────────────────────────
            agentServer = container "Agent Server" "外脑 + spawn + Hono API" "Node.js @utlra/server" {
                properties {
                    "path" "packages/server"
                    "entry" "packages/server/src/index.ts"
                    "horizon.intention" "外脑编排与内脑生命周期"
                    "horizon.in" "ChatIRInboundEvent; HTTP API"
                    "horizon.out" "StructuredReply; spawn; mem9/drive9 写"
                    "horizon.deps" "chat-ir, core, llm, mem9, drive9"
                }

                !include components/agent-server.dsl
            }

            innerWorker = container "Inner Brain Worker" "子进程：openkuroneko 阶段机 + 反思" "Node.js child_process" {
                properties {
                    "path" "packages/server/src/pi-mono/inner-brain-worker.ts"
                    "horizon.intention" "在 workDir 内跑 Pi-mono 阶段循环"
                    "horizon.in" "INNER_* env; directives"
                    "horizon.out" "DONE/BLOCK; .brain/; reflexion.json"
                    "horizon.deps" "与 workspaceKit 共享 workDir；drive9 via tools; llmGateway（经 agentServer）"
                }

                !include components/inner-worker.dsl
            }

            discordBridge = container "Discord Bridge" "Discord ↔ ChatIR" "Node.js @utlra/discord-bridge" {
                properties {
                    "path" "packages/discord-bridge"
                    "horizon.intention" "Discord 渠道适配"
                    "horizon.in" "Gateway; postMessage"
                    "horizon.out" "ChatIRInboundEvent; REST send; seenTracker.track(mention_target_sids)"
                    "horizon.deps" "chat-ir"
                }
            }

            webchatBridge = container "WebChat Bridge" "chat-server ↔ agent；出站 asset: → POST /uploads" "Node.js @utlra/webchat-bridge" {
                properties {
                    "path" "packages/webchat-bridge"
                    "horizon.intention" "入站 WS→IR；出站 IR→REST（含 ChatAssetStore 附件上传）"
                    "horizon.in" "chat-server 事件; agent postMessage(parts)"
                    "horizon.out" "ChatIR 映射; attachment_ids; seenTracker.track(mention_target_sids)"
                    "horizon.protocol" "doc/protocols/webchat-wire.md §4"
                    "horizon.test.unit" "asset-upload.test.ts; reply-render.test.ts"
                    "horizon.deps" "chat-ir, webchat-protocol"
                }
            }

            chatServer = container "Chat Server" "本地 IM 服务：REST + WS 消息枢纽（大群/私聊）" "Node.js apps/chat-server" {
                properties {
                    "path" "apps/chat-server"
                    "horizon.intention" "本地 WebChat IM 服务端"
                    "horizon.in" "HTTP/WS 客户端（web-chat）"
                    "horizon.out" "线程/消息事件"
                    "horizon.deps" "webchat-protocol"
                }
            }

            webChat = container "Web Chat UI" "Vite React 客户端" "TypeScript apps/web-chat" {
                properties {
                    "path" "apps/web-chat"
                    "horizon.in" "用户交互"
                    "horizon.out" "HTTP/WS 请求"
                    "horizon.deps" "webchat-protocol"
                }
            }

            opsConsole = container "Ops Console" "本地运维 Web：启停 agent/dashboard、跨实例 KPI 调试" "Hono + Vite apps/ops-console" {
                tags "Monitoring"
                properties {
                    "path" "apps/ops-console"
                    "horizon.intention" "运维观察与调试，非 IM 对话"
                    "horizon.in" "操作者浏览器"
                    "horizon.out" "调用 agent /api/kpis、触发 reflexion burst"
                }
            }

            performanceDashboard = container "Performance Dashboard" "KPI/性能目标可视化（含 agent 托管 API）" "Vite apps/dashboard" {
                tags "Monitoring"
                properties {
                    "path" "apps/dashboard"
                    "horizon.intention" "外脑/内脑与 performance goals 只读视图"
                    "horizon.in" "HTTP"
                    "horizon.out" "图表与列表"
                }
            }
        }

        // ── L1（用户只经 IM；监控走 ops/dashboard）────────────────
        user -> discord "使用 Discord 客户端" "Discord 桌面/移动客户端" {
            tags "http,ws"
        }
        user -> localWebChatIm "使用 Web Chat 浏览器" "HTTPS/WSS" {
            tags "http,ws"
        }
        discord -> kuroneko "入站消息 / Gateway" "WSS + REST" {
            tags "ws,http"
        }
        kuroneko -> discord "出站回复" "REST" {
            tags "http"
        }
        localWebChatIm -> kuroneko "ChatIR 入站、StructuredReply 出站" "HTTP/WS" {
            tags "http,ws"
        }
        kuroneko -> localWebChatIm "经 bridge 推送回复" "HTTP/WS" {
            tags "http,ws"
        }
        operator -> brainMonitoring "查看 KPI、内外脑、性能" "HTTPS" {
            tags "http"
        }
        brainMonitoring -> kuroneko "拉取 /api/kpis、inner-brains、performance" "HTTPS" {
            tags "http"
        }
        kuroneko -> llm "推理与 tool calls" "HTTPS" {
            tags "http"
        }
        kuroneko -> mem9 "记忆 store/search" "HTTPS" {
            tags "http"
        }
        kuroneko -> drive9 "技能读写" "HTTPS" {
            tags "http"
        }

        // ── L2 库依赖（import 国境雏形）──────────────────────────
        kuroneko.discordBridge -> kuroneko.chatIrLib "ChatIRChannel + seenTracker.track(mention)" "npm import" {
            tags "import"
        }
        kuroneko.webchatBridge -> kuroneko.chatIrLib "ChatIR 映射 + seenTracker.track(mention)" "npm import" {
            tags "import"
        }
        kuroneko.webchatBridge -> kuroneko.webchatProtocolLib "共享 DTO" "npm import" {
            tags "import"
        }
        kuroneko.chatServer -> kuroneko.webchatProtocolLib "REST/WS 类型" "npm import" {
            tags "import"
        }
        kuroneko.webChat -> kuroneko.webchatProtocolLib "客户端类型" "npm import" {
            tags "import"
        }
        kuroneko.agentServer -> kuroneko.chatIrLib "外脑 ChatIR" "npm import" {
            tags "import"
        }
        kuroneko.agentServer -> kuroneko.workspaceKit "InnerBrainEngine / workspaceStore" "npm import" {
            tags "import"
        }
        kuroneko.innerWorker -> kuroneko.workspaceKit "共享 workDir（.brain / .run 文件契约）" "同盘读写" {
            tags "file"
        }
        kuroneko.workspaceKit -> kuroneko.innerWorker "goal.md / controller-state（外脑经 engine 写 .brain）" "同盘读写" {
            tags "file"
        }

        // ── L2 Discord 路径 ───────────────────────────────────────
        discord -> kuroneko.discordBridge "MESSAGE_CREATE" "WSS" {
            tags "ws"
        }
        kuroneko.discordBridge -> kuroneko.agentServer "ChatIRInboundEvent" "in-process" {
            tags "import"
        }
        kuroneko.agentServer -> kuroneko.discordBridge "StructuredReply" "in-process" {
            tags "import"
        }
        kuroneko.discordBridge -> discord "messages.create" "HTTPS" {
            tags "http"
        }

        // ── L2 WebChat 路径 ─────────────────────────────────────
        user -> kuroneko.webChat "浏览输入" "HTTPS" {
            tags "http"
        }
        kuroneko.webChat -> kuroneko.chatServer "REST + WS" "HTTPS/WSS" {
            tags "http,ws"
        }
        kuroneko.chatServer -> kuroneko.webchatBridge "线程与消息" "HTTP/WS" {
            tags "http,ws"
        }
        kuroneko.webchatBridge -> kuroneko.agentServer "入站/出站映射" "HTTP + bridge" {
            tags "import,http"
        }
        kuroneko.agentServer -> kuroneko.webchatBridge "agent 回复" "HTTP + bridge" {
            tags "import"
        }

        // ── L2 外脑 ↔ 云 / LLM ──────────────────────────────────
        kuroneko.agentServer -> llm "messages + tools" "HTTPS" {
            tags "http"
        }
        kuroneko.agentServer -> mem9 "OuterMemoryStore" "HTTPS" {
            tags "http"
        }
        kuroneko.agentServer -> drive9 "SkillDrive9 + KnowledgeDrive9 + AgentPool" "HTTPS" {
            tags "http"
        }

        // ── L2 外脑 ↔ 内脑 ──────────────────────────────────────
        kuroneko.agentServer -> kuroneko.innerWorker "spawn + env" "child_process" {
            tags "spawn,file"
        }
        kuroneko.innerWorker -> kuroneko.agentServer "DONE/BLOCK/status" "stdio + file" {
            tags "file"
        }
        kuroneko.innerWorker -> drive9 "query_available_skills" "HTTPS" {
            tags "http"
        }

        // ── L2 监控（非 IM）──────────────────────────────────────
        operator -> kuroneko.opsConsole "运维操作" "HTTPS" {
            tags "http"
        }
        operator -> kuroneko.performanceDashboard "查看面板" "HTTPS" {
            tags "http"
        }
        kuroneko.opsConsole -> kuroneko.agentServer "/api/kpis、inner-brains、reflexion" "HTTPS" {
            tags "http"
        }
        kuroneko.performanceDashboard -> kuroneko.agentServer "/api/performance/goals" "HTTPS" {
            tags "http"
        }

        // ── L3 外脑：双入口（IM Facade / HTTP Orchestrator）────────────────
        // IM 主路径
        kuroneko.agentServer.outerBrainFacade -> kuroneko.agentServer.threadOrchestrator "schedule(jitter/FIFO) + makeFreshCheck" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.threadOrchestrator -> kuroneko.chatIrLib "ChatIRSeenTracker.hasAnotherAgentRepliedAfter" "npm import" {
            tags "import"
        }
        kuroneko.agentServer.outerBrainFacade -> kuroneko.agentServer.knowledgeRetrieval "retrieveComprehensiveKnowledge" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.outerBrainFacade -> kuroneko.agentServer.outerMemory "readMemoryContext" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.outerBrainFacade -> kuroneko.agentServer.participationPolicy "decideOuterShouldReply" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.outerBrainFacade -> kuroneko.agentServer.awaitingInboundResolver "resolve ask_user on human IM (before loop)" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.awaitingInboundResolver -> kuroneko.agentServer.innerBrainRegistry "match AWAITING by originThread" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.outerBrainFacade -> kuroneko.agentServer.outerConversationLoop "runOuterConversationLoop" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.threadOrchestrator -> kuroneko.agentServer.outerConversationLoop "mention-aware freshCheck → ctx" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.participationPolicy -> kuroneko.agentServer.llmGateway "SPEAK/SILENT / topic check" "HTTPS" {
            tags "http"
        }
        kuroneko.agentServer.outerConversationLoop -> kuroneko.agentServer.llmGateway "多轮 messages+tools" "HTTPS" {
            tags "http"
        }
        kuroneko.agentServer.outerConversationLoop -> kuroneko.agentServer.outerToolExecutor "executeOuterTool" "in-process" {
            tags "import"
        }
        // HTTP roundtrip 路径（不经 Facade）
        kuroneko.agentServer.outerOrchestrator -> kuroneko.agentServer.participationPolicy "decideOuterShouldReply" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.outerOrchestrator -> kuroneko.agentServer.innerSpawner "spawnInnerBurst（不经 registry）" "child_process" {
            tags "spawn"
        }
        kuroneko.agentServer.outerOrchestrator -> kuroneko.agentServer.llmGateway "draftOuterStructuredReply（可选）" "HTTPS" {
            tags "http"
        }
        // 工具 → 内脑 / KPI / 通知
        kuroneko.agentServer.outerToolExecutor -> kuroneko.agentServer.innerBrainRegistry "register / list / stop" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.outerToolExecutor -> kuroneko.agentServer.innerBrainKpiReuse "set_goal(kpi_id): findCanonical / reuse workDir" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.outerToolExecutor -> kuroneko.agentServer.workspaceInbox "set_goal: prepareKpiPeerHandoff（peer ids + .inbox catalog）" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.workspaceInbox -> kuroneko.agentServer.innerBrainRegistry "list/get sibling TaskRecord" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.workspaceInbox -> kuroneko.agentServer.kpiRegistry "kpi.bursts → workspace ids" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.innerBrainKpiReuse -> kuroneko.agentServer.innerBrainRegistry "get / update canonical TaskRecord" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.innerBrainKpiReuse -> kuroneko.agentServer.kpiRegistry "kpi.bursts → canonical instanceId" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.outerToolExecutor -> kuroneko.agentServer.innerSpawner "set_goal → spawn worker（新建或续跑 canonical）" "child_process" {
            tags "spawn"
        }
        kuroneko.agentServer.outerToolExecutor -> kuroneko.agentServer.awaitingNotify "onExit AWAITING → 等人类 IM" "in-process" {
        }
        kuroneko.agentServer.outerToolExecutor -> kuroneko.agentServer.completionNotify "onExit DONE → 通知用户" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.outerToolExecutor -> kuroneko.agentServer.kpiBurstHooks "processBurstExitForKpi" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.outerToolExecutor -> kuroneko.agentServer.kpiRegistry "set_kpi / view_kpi" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.outerToolExecutor -> kuroneko.agentServer.memoryBlockStore "memory_block_* list/put/bind" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.memoryBlockStore -> drive9 "vault/blocks entries" "HTTPS" {
            tags "http"
        }
        kuroneko.agentServer.memoryBlockStore -> kuroneko.agentServer.innerBrainRegistry "bind → workDir/.brain/secrets" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.innerBrainRegistry -> kuroneko.agentServer.innerSpawner "spawnAndAttachWorker" "child_process" {
            tags "spawn"
        }
        // 外脑 agentServer 进程启动：恢复中断的 RUNNING burst（实现 index.ts autoResumeStaleTasks）
        kuroneko.agentServer.innerBrainStartupResume -> kuroneko.agentServer.innerBrainRegistry "markStaleRunningAsStopped → 待恢复列表" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.innerBrainStartupResume -> kuroneko.agentServer.innerSpawner "spawnAndAttachWorker(incrementResumeCount)" "child_process" {
            tags "spawn"
        }
        kuroneko.agentServer.registryLifecycleReconcile -> kuroneko.agentServer.innerBrainRegistry "list AWAITING|BLOCKED → update DONE" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.registryLifecycleReconcile -> kuroneko.agentServer.brainAsyncSnapshot "buildBrainAsyncSnapshot per workDir" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.changeWatcher -> kuroneko.agentServer.registryLifecycleReconcile "bootstrap: reconcile before first tick" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.changeWatcher -> kuroneko.agentServer.brainAsyncSnapshot "read pendings snapshot per workDir" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.kpiBurstHooks -> kuroneko.agentServer.kpiRegistry "更新 trail / idle" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.kpiBurstHooks -> kuroneko.agentServer.innerSpawner "scheduleReflexion/Next → spawn canonical（index + innerBrainKpiReuse）" "in-process" {
            tags "spawn"
        }
        kuroneko.agentServer.kpiBurstHooks -> kuroneko.agentServer.innerBrainKpiReuse "schedule* 经 index 调 patchCanonical" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.pushLoop -> kuroneko.agentServer.innerBrainRegistry "list RUNNING/BLOCKED/AWAITING" "in-process" {
            tags "import"
        }

        // ── L3 内脑：调度 → 三阶段 → 反思 ───────────────────────
        kuroneko.innerWorker.workerHost -> kuroneko.innerWorker.piMonoScheduler "run-tick" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.piMonoScheduler -> kuroneko.innerWorker.workdirGuard "setWorkDirGuard + setPeerWorkspaces" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.innerFileTools -> kuroneko.innerWorker.workdirGuard "path security check" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.piMonoScheduler -> kuroneko.innerWorker.controllerFsm "tick()" "in-process" {
            tags "import"
        }

        // ── DyFlow engine ────────────────────────────────────────────────
        kuroneko.innerWorker.controllerFsm -> kuroneko.innerWorker.designer "mode=DESIGN" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.controllerFsm -> kuroneko.innerWorker.runner "mode=RUN" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.designer -> kuroneko.innerWorker.designerToolRegistry "tools allowlist" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.designer -> kuroneko.innerWorker.memoryStore "read goal/last_failure/facts/constraints" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.designer -> kuroneko.innerWorker.localNodeStore "list / read LocalNode" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.designer -> kuroneko.agentServer.llmGateway "DESIGN LLM" "HTTPS" {
            tags "http"
        }
        kuroneko.innerWorker.runner -> kuroneko.innerWorker.baseNodeExecutor "dispatch baseNode" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.runner -> kuroneko.innerWorker.nodeCreatorExecutor "dispatch nodeCreator" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.runner -> kuroneko.innerWorker.localNodeStore "resolve ref → LocalNode" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.runner -> kuroneko.innerWorker.memoryStore "write node_results / last_failure" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.baseNodeExecutor -> kuroneko.innerWorker.innerFileTools "RUN tool_calls" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.baseNodeExecutor -> kuroneko.agentServer.llmGateway "ReAct LLM" "HTTPS" {
            tags "http"
        }
        kuroneko.innerWorker.nodeCreatorExecutor -> kuroneko.agentServer.llmGateway "pack/specialize LLM" "HTTPS" {
            tags "http"
        }
        kuroneko.innerWorker.nodeCreatorExecutor -> kuroneko.innerWorker.localNodeStore "commit_local_node" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.nodeCreatorExecutor -> kuroneko.innerWorker.nodeAbstractor "fire-and-forget on commit" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.nodeAbstractor -> kuroneko.agentServer.llmGateway "placeholder 推断 LLM" "HTTPS" {
            tags "http"
        }
        kuroneko.innerWorker.nodeAbstractor -> kuroneko.agentServer.nodeDefDrive9Store "put NodeDef + index" "HTTPS" {
            tags "http"
        }
        kuroneko.innerWorker.nodeAssembler -> kuroneko.agentServer.llmGateway "binding 推断 LLM" "HTTPS" {
            tags "http"
        }
        kuroneko.innerWorker.nodeAssembler -> kuroneko.innerWorker.localNodeStore "commit imported LocalNode" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.designerToolRegistry -> kuroneko.innerWorker.nodeAssembler "search_and_instance 内循环" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.designerToolRegistry -> kuroneko.agentServer.nodeDefDrive9Store "search NodeDef catalog" "HTTPS" {
            tags "http"
        }
        kuroneko.innerWorker.designerToolRegistry -> kuroneko.innerWorker.localNodeStore "list / read" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.designerToolRegistry -> kuroneko.innerWorker.memoryStore "read / report_done" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.workerHost -> kuroneko.innerWorker.presetSeeder "首次 spawn 注入 preset/*" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.presetSeeder -> kuroneko.innerWorker.localNodeStore "write preset LocalNode" "file" {
            tags "file"
        }
        kuroneko.agentServer.outerHeartbeat -> kuroneko.agentServer.nodeDefEviction "tick sweep（P2）" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.nodeDefEviction -> kuroneko.agentServer.nodeDefDrive9Store "list/tombstone NodeDef" "HTTPS" {
            tags "http"
        }
        kuroneko.innerWorker.controllerFsm -> kuroneko.innerWorker.archiveStore "archive(kpiId)" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.brainFs -> kuroneko.agentServer.kpiBurstHooks "readReflexionFromWorkspace" "file" {
            tags "file"
        }
        kuroneko.agentServer.innerSpawner -> kuroneko.innerWorker.workerHost "INNER_KPI_ID + workDir" "child_process" {
            tags "spawn"
        }
        kuroneko.agentServer.innerBrainRegistry -> kuroneko.agentServer.changeWatcher "list AWAITING tasks" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.changeWatcher -> kuroneko.agentServer.innerSpawner "spawn on resolved pending" "child_process" {
            tags "spawn"
        }

        // ── L3 外脑：心跳 / 资源感知 / 自主调度 ─────────────────
        kuroneko.agentServer.outerHeartbeat -> kuroneko.agentServer.kpiCompletionJudge "tick sweepKpiCompletions + digest" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.kpiCompletionJudge -> kuroneko.agentServer.kpiRegistry "markAchieved / list active" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.kpiCompletionJudge -> kuroneko.agentServer.innerBrainRegistry "buildKpiBurstLinks / live burst" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.outerHeartbeat -> kuroneko.agentServer.resourceProbe "collect ResourceSnapshot" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.outerHeartbeat -> kuroneko.agentServer.autonomyPolicyStore "load policy + rubric" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.outerHeartbeat -> kuroneko.agentServer.autonomyJudge "evaluate idle|busy" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.outerHeartbeat -> kuroneko.agentServer.performanceGoalEngine "reviewGoalsForHeartbeat" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.resourceProbe -> kuroneko.agentServer.innerBrainRegistry "count RUNNING/AWAITING/BLOCKED" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.resourceProbe -> kuroneko.agentServer.llmUsageTracker "tokens + inFlight" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.resourceProbe -> kuroneko.agentServer.threadOrchestrator "orchestrator queue depth" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.llmUsageTracker -> kuroneko.agentServer.llmGateway "wrap chat/completions" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.llmUsageTracker -> kuroneko.agentServer.llmUsageJournal "persist usage entries" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.autonomyJudge -> kuroneko.agentServer.autonomyPolicyStore "hardGates" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.outerHeartbeat -> kuroneko.agentServer.autonomyTaskDispatcher "verdict=idle → KPI优先/闲聊概率" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.autonomyTaskDispatcher -> kuroneko.agentServer.agentPersonality "idleChatProbability" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.autonomyTaskDispatcher -> kuroneko.agentServer.outerToolExecutor "post_to_im / set_goal" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.autonomyTaskDispatcher -> kuroneko.agentServer.participationPolicy "casual_chat 频控" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.autonomyTaskDispatcher -> kuroneko.agentServer.kpiRegistry "hasKpi → kpi_inner_goal" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.autonomyTaskDispatcher -> kuroneko.agentServer.performanceGoalEngine "（P1 可选）scorecard" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.outerConversationLoop -> kuroneko.agentServer.autonomyPolicyStore "read/update via chat tools" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.outerToolExecutor -> kuroneko.agentServer.autonomyPolicyStore "read_autonomy_policy / update_*" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.outerToolExecutor -> kuroneko.agentServer.agentPersonality "read/update_personality" "in-process" {
            tags "import"
        }

        // ── L3 外脑：环境模型（P1 起替代 resourceProbe） ─────────────
        kuroneko.agentServer.environmentSensorRegistry -> kuroneko.agentServer.innerBrainRegistry "innerBrains sensor read" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.environmentSensorRegistry -> kuroneko.agentServer.llmUsageJournal "llmUsage sensor read" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.environmentSensorRegistry -> kuroneko.agentServer.threadOrchestrator "inbound sensor read" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.environmentSensorRegistry -> kuroneko.agentServer.environmentChangeDetector "diff + derive + detectEvents" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.environmentChangeDetector -> kuroneko.agentServer.environmentJournal "ring + events + hourly" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.environmentJournal -> kuroneko.agentServer.environmentJournal "rotate events.jsonl / hourly.jsonl" "file" {
            tags "file"
        }
        kuroneko.agentServer.outerHeartbeat -> kuroneko.agentServer.environmentSensorRegistry "P1 collect EnvironmentSnapshot" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.autonomyJudge -> kuroneko.agentServer.environmentSensorRegistry "P1 read EnvironmentSnapshot.facets" "in-process" {
            tags "import"
        }

        // ── L3 外脑：战略规划层 ─────────────────────────────────────
        kuroneko.agentServer.outerHeartbeat -> kuroneko.agentServer.strategyStore "loadCurrent + recentEvents" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.outerHeartbeat -> kuroneko.agentServer.strategyPlanner "shouldReevaluate? planNext" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.outerHeartbeat -> kuroneko.agentServer.staleBurstReaper "execute(cull + staleAwaitingPolicy) before dispatch" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.strategyPlanner -> kuroneko.agentServer.strategyStore "writeCurrent + appendJournal" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.strategyPlanner -> kuroneko.agentServer.environmentJournal "envEvents (unconsumed) + envHourly" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.strategyPlanner -> kuroneko.agentServer.kpiRegistry "kpis + reflexionTrail digest" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.strategyPlanner -> kuroneko.agentServer.performanceGoalEngine "scorecards" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.strategyPlanner -> kuroneko.agentServer.llmGateway "REFLECT+DESIGN LLM" "HTTPS" {
            tags "http"
        }
        kuroneko.agentServer.strategyPlanner -> kuroneko.agentServer.innerBrainRegistry "recentBursts + AWAITING list" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.staleBurstReaper -> kuroneko.agentServer.strategyStore "read cullDirectives + staleAwaitingPolicy" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.staleBurstReaper -> kuroneko.agentServer.innerBrainRegistry "ABORTED state migration" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.staleBurstReaper -> kuroneko.agentServer.awaitingInboundResolver "peekPendingMatch（避免杀正在收敛）" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.staleBurstReaper -> kuroneko.innerWorker.archiveStore "archive(workDir, abortReason)" "file" {
            tags "file"
        }
        kuroneko.agentServer.autonomyTaskDispatcher -> kuroneko.agentServer.strategyStore "P1 read focusOrder（替代自由选 KPI）" "in-process" {
            tags "import"
        }
    }

    views {
        systemContext kuroneko "01-L1-SystemContext" {
            include user operator discord localWebChatIm brainMonitoring kuroneko llm mem9 drive9
            autolayout lr
        }

        container kuroneko "02-L2-AllContainers" {
            include *
            autolayout tb
        }

        container kuroneko "03-L2-Discord-path" {
            include user discord kuroneko.discordBridge kuroneko.chatIrLib kuroneko.agentServer kuroneko.workspaceKit kuroneko.innerWorker llm mem9 drive9
            autolayout lr
        }

        container kuroneko "04-L2-WebChat-path" {
            include user kuroneko.webChat kuroneko.chatServer kuroneko.webchatProtocolLib kuroneko.webchatBridge kuroneko.chatIrLib kuroneko.agentServer kuroneko.workspaceKit kuroneko.innerWorker
            autolayout tb
        }

        container kuroneko "05-L2-Libraries" {
            include kuroneko.chatIrLib kuroneko.workspaceKit kuroneko.webchatProtocolLib kuroneko.agentServer kuroneko.discordBridge kuroneko.webchatBridge kuroneko.chatServer kuroneko.webChat
            autolayout lr
        }

        component kuroneko.agentServer "06-L3-Outer-AllModules" {
            include element.tag==Outer-Module
            autolayout tb
        }

        component kuroneko.agentServer "07-L3-Outer-Inbound-IM" {
            title "L3 Outer — IM 入站（Facade 路径）"
            include kuroneko.agentServer.outerBrainFacade kuroneko.agentServer.awaitingInboundResolver kuroneko.agentServer.innerBrainRegistry kuroneko.agentServer.threadOrchestrator kuroneko.agentServer.knowledgeRetrieval kuroneko.agentServer.outerMemory kuroneko.agentServer.memoryBlockStore kuroneko.agentServer.participationPolicy kuroneko.agentServer.llmGateway kuroneko.agentServer.outerConversationLoop kuroneko.agentServer.outerToolExecutor
            autolayout tb
        }

        component kuroneko.agentServer "07b-L3-Outer-Inbound-HTTP" {
            title "L3 Outer — HTTP roundtrip（Orchestrator 路径）"
            include kuroneko.agentServer.outerOrchestrator kuroneko.agentServer.participationPolicy kuroneko.agentServer.llmGateway kuroneko.agentServer.innerSpawner
            autolayout lr
        }

        component kuroneko.agentServer "08-L3-Outer-Inner-Lifecycle" {
            title "L3 Outer — 内脑 spawn / 重启恢复 / AWAITING 对账 / 通知 / KPI"
            include kuroneko.agentServer.outerToolExecutor kuroneko.agentServer.innerBrainRegistry kuroneko.agentServer.innerBrainKpiReuse kuroneko.agentServer.workspaceInbox kuroneko.agentServer.brainAsyncSnapshot kuroneko.agentServer.registryLifecycleReconcile kuroneko.agentServer.innerBrainStartupResume kuroneko.agentServer.innerSpawner kuroneko.agentServer.changeWatcher kuroneko.agentServer.imNotifyDedup kuroneko.agentServer.awaitingNotify kuroneko.agentServer.completionNotify kuroneko.agentServer.pushLoop kuroneko.agentServer.kpiRegistry kuroneko.agentServer.kpiBurstHooks kuroneko.innerWorker.workerHost
            autolayout tb
        }

        component kuroneko.innerWorker "09-L3-Inner-Phases" {
            title "L3 内脑 — DyFlow Phases (DESIGN/RUN/AWAITING/DONE)"
            include element.tag==Inner-Phase element.tag==Inner-Scheduler element.tag==Inner-Tools kuroneko.innerWorker.controllerFsm kuroneko.innerWorker.brainFs kuroneko.innerWorker.archiveStore kuroneko.innerWorker.workerHost kuroneko.innerWorker.piMonoScheduler kuroneko.innerWorker.workdirGuard kuroneko.innerWorker.innerFileTools
            autolayout tb
        }

        component kuroneko.innerWorker "09b-L3-Inner-DyFlow" {
            title "L3 内脑 — DyFlow（designer/runner/baseNode/Creator + LocalNode/Memory + Abstractor/Assembler）"
            include kuroneko.innerWorker.controllerFsm kuroneko.innerWorker.designer kuroneko.innerWorker.runner kuroneko.innerWorker.baseNodeExecutor kuroneko.innerWorker.nodeCreatorExecutor kuroneko.innerWorker.localNodeStore kuroneko.innerWorker.memoryStore kuroneko.innerWorker.designerToolRegistry kuroneko.innerWorker.presetSeeder kuroneko.innerWorker.nodeAbstractor kuroneko.innerWorker.nodeAssembler kuroneko.innerWorker.innerFileTools kuroneko.innerWorker.workerHost kuroneko.innerWorker.piMonoScheduler kuroneko.agentServer.llmGateway kuroneko.agentServer.nodeDefDrive9Store
            autolayout tb
        }

        container kuroneko "10-L2-KPI-Closed-Loop" {
            title "KPI 闭环（agentServer ↔ innerWorker + 共享 workDir）"
            include kuroneko.agentServer kuroneko.innerWorker
            autolayout tb
        }

        component kuroneko.agentServer "10b-L3-Outer-KPI" {
            title "L3 外脑 — KPI 调度与 onExit"
            include kuroneko.agentServer.kpiRegistry kuroneko.agentServer.kpiBurstHooks kuroneko.agentServer.kpiCompletionJudge kuroneko.agentServer.innerBrainKpiReuse kuroneko.agentServer.outerToolExecutor kuroneko.agentServer.innerBrainRegistry kuroneko.agentServer.workspaceInbox kuroneko.agentServer.innerSpawner
            autolayout tb
        }

        component kuroneko.agentServer "11-L3-Outer-Autonomy" {
            title "L3 外脑 — 心跳（KPI完成判定+质控+战略+自主调度）"
            include kuroneko.agentServer.outerHeartbeat kuroneko.agentServer.kpiCompletionJudge kuroneko.agentServer.resourceProbe kuroneko.agentServer.llmUsageTracker kuroneko.agentServer.autonomyPolicyStore kuroneko.agentServer.agentPersonality kuroneko.agentServer.autonomyJudge kuroneko.agentServer.autonomyTaskDispatcher kuroneko.agentServer.performanceGoalEngine kuroneko.agentServer.outerToolExecutor kuroneko.agentServer.participationPolicy kuroneko.agentServer.kpiRegistry kuroneko.agentServer.innerBrainRegistry kuroneko.agentServer.threadOrchestrator kuroneko.agentServer.llmGateway kuroneko.agentServer.outerConversationLoop
            autolayout tb
        }

        component kuroneko.agentServer "12-L3-Outer-Environment" {
            title "L3 外脑 — 环境模型（sensor registry / journal / change detector / 消费方）"
            include kuroneko.agentServer.environmentSensorRegistry kuroneko.agentServer.environmentJournal kuroneko.agentServer.environmentChangeDetector kuroneko.agentServer.outerHeartbeat kuroneko.agentServer.autonomyJudge kuroneko.agentServer.strategyPlanner kuroneko.agentServer.innerBrainRegistry kuroneko.agentServer.llmUsageJournal kuroneko.agentServer.threadOrchestrator
            autolayout tb
        }

        component kuroneko.agentServer "13-L3-Outer-Strategy" {
            title "L3 外脑 — 战略层（reflect/design + reaper + dispatch）"
            include kuroneko.agentServer.outerHeartbeat kuroneko.agentServer.strategyStore kuroneko.agentServer.strategyPlanner kuroneko.agentServer.staleBurstReaper kuroneko.agentServer.autonomyTaskDispatcher kuroneko.agentServer.kpiRegistry kuroneko.agentServer.performanceGoalEngine kuroneko.agentServer.environmentJournal kuroneko.agentServer.innerBrainRegistry kuroneko.agentServer.awaitingInboundResolver kuroneko.agentServer.llmGateway kuroneko.agentServer.outerToolExecutor kuroneko.innerWorker.archiveStore
            autolayout tb
        }

        container kuroneko "14-L2-DyFlow-Node-Lifecycle" {
            title "L2 DyFlow — LocalNode → NodeDef（drive9）共享 + eviction 治理"
            include kuroneko.innerWorker kuroneko.agentServer drive9
            autolayout tb
        }

        styles {
            element "Person" {
                shape person
            }
            element "Software System" {
                background #1168bd
                color #ffffff
            }
            element "Container" {
                background #438dd5
                color #ffffff
            }
            element "Component" {
                background #85bbf0
                color #000000
            }
            element "External" {
                background #999999
                color #ffffff
            }
            element "Library" {
                background #5d6d7e
                color #ffffff
            }
            element "Toolkit" {
                background #7f8c8d
                color #ffffff
            }
            element "IM-Interface" {
                background #8e44ad
                color #ffffff
            }
            element "Monitoring" {
                background #16a085
                color #ffffff
            }
            relationship "spawn" {
                color #c0392b
                thickness 3
                dashed true
            }
            relationship "file" {
                color #27ae60
                dashed true
            }
            relationship "http" {
                color #2980b9
            }
            relationship "ws" {
                color #8e44ad
                dashed true
            }
            relationship "import" {
                color #f39c12
            }
        }
    }

    configuration {
        scope softwaresystem
    }
}

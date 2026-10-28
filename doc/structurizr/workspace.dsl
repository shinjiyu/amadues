workspace "Kuroneko" "ADL authority: L1-L2 integration + L3 agentServer modules. Horizon props: horizon.intention|in|out|deps. Tags: http|ws|spawn|file|import." {

    !identifiers hierarchical

    model {
        user = person "用户" "仅经 IM 渠道对话与派任务；不直连 Agent API"

        operator = person "运维/观察者" "ops-console、performance dashboard；查看工人与工作台"

        discord = softwareSystem "Discord" "外部 IM（Gateway + REST）" {
            tags "External" "IM-Interface"
        }

        feishu = softwareSystem "飞书 / Lark" "外部 IM：企业自建应用机器人；一 agent 可 N 条连接（非单例）" {
            tags "External" "IM-Interface"
            properties {
                "horizon.note" "见 IDENTITY-CROSS-CHANNEL.md §5；热插凭证走 keychain；P4a 扫码建应用（registerApp device flow）与手填 app_id/secret 并存"
            }
        }

        wechat = softwareSystem "微信 iLink（ClawBot）" "外部 IM：个人微信号 Bot API（ilinkai.weixin.qq.com）；扫码登录、长轮询、基本仅私聊" {
            tags "External" "IM-Interface"
            properties {
                "horizon.note" "见 IDENTITY-CROSS-CHANNEL.md §6.6 P4b；bot_token 走 keychain；一号一连接"
            }
        }

        localWebChatIm = softwareSystem "本地 WebChat IM" "apps/chat-server REST/WS 枢纽 + web-chat 浏览器；自建对话入口" {
            tags "IM-Interface"
            properties {
                "realizedBy" "kuroneko.chatServer + kuroneko.webChat"
                "path" "apps/chat-server; apps/web-chat"
            }
        }

        brainMonitoring = softwareSystem "内外脑监控" "ops-console 启停 + dashboard 查看工人与工作台" {
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
            chatIrLib = container "Chat IR" "消息/线程 schema、ChatIRChannel、FanInChatIRChannel（多连接合流/路由）、ChatIRSeenTracker、identityBindingIndex（channel_key→sid）、StructuredReply" "npm @utlra/chat-ir" {
                tags "Library"
                properties {
                    "path" "packages/chat-ir"
                    "horizon.intention" "渠道无关聊天中间表示 + 身份映射索引 + 运行时观察（反 loop / 抢答）"
                    "horizon.in" "Channel track/postMessage；mention parts；channel_key resolve/bind"
                    "horizon.out" "类型契约；hasAnotherAgentRepliedAfter；resolve→internal_sid"
                    "horizon.deps" "无 kuroneko 业务包"
                    "horizon.adl" "doc/structurizr/IDENTITY-CROSS-CHANNEL.md"
                    "horizon.test.unit" "packages/chat-ir/src/seen-tracker.test.ts；identity-binding-index.test.ts（⏳）"
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

            innerWorker = container "Inner Brain Worker" "子进程：一名工人在一张工作台上执行" "Node.js child_process" {
                properties {
                    "path" "packages/server/src/pi-mono/inner-brain-worker.ts"
                    "horizon.intention" "在 workDir 内跑 Pi-mono 阶段循环"
                    "horizon.in" "INNER_* env; directives"
                    "horizon.out" "DONE/BLOCK; .brain/"
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

            feishuBridge = container "Feishu Bridge" "飞书 ↔ ChatIR；N 连接/热插；入站经 identityBindingIndex.resolve" "Node.js @utlra/feishu-bridge" {
                properties {
                    "path" "packages/feishu-bridge"
                    "horizon.intention" "多 app 飞书机器人适配；非单例；Typing=reaction"
                    "horizon.in" "长连接事件; postMessage; channelConnectionRegistry 连接集"
                    "horizon.out" "ChatIRInboundEvent（sender 经 resolve）; REST send; reaction Typing"
                    "horizon.deps" "chat-ir; channelConnectionRegistry; identityBindingIndex"
                    "horizon.test.unit" "api-client.test.ts; inbound.test.ts; feishu-channel.test.ts; connector.test.ts; thread-mapper.test.ts; scan-register.test.ts"
                    "horizon.status" "✅ P2b（长连接事件源 = @larksuiteoapi/node-sdk 可选依赖，未装时热插显式报错）；✅ P4a scan-register（registerApp device flow 包装，可注入）"
                    "horizon.adl" "doc/structurizr/IDENTITY-CROSS-CHANNEL.md §5"
                }
            }

            wechatBridge = container "WeChat Bridge" "微信 iLink ↔ ChatIR；扫码登录 bot_token；长轮询收消息；context_token 会话锚点" "Node.js @utlra/wechat-bridge" {
                properties {
                    "path" "packages/wechat-bridge"
                    "horizon.intention" "个人微信 ClawBot 适配；一号一连接；Typing=sendtyping"
                    "horizon.in" "getupdates 长轮询; postMessage; channelConnectionRegistry 连接集"
                    "horizon.out" "ChatIRInboundEvent（sender 经 resolve）; sendmessage（回传 context_token）"
                    "horizon.deps" "chat-ir; channelConnectionRegistry; identityBindingIndex"
                    "horizon.test.unit" "ilink-api-client.test.ts; inbound.test.ts; wechat-channel.test.ts; connector.test.ts; thread-mapper.test.ts"
                    "horizon.status" "✅ P4b（凭证=扫码登录 bot_token JSON，keychain 持有；-14 过期显式 down 待重扫）"
                    "horizon.adl" "doc/structurizr/IDENTITY-CROSS-CHANNEL.md §6.6"
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

            opsConsole = container "Ops Console" "本地运维 Web：启停 agent 与 dashboard" "Hono + Vite apps/ops-console" {
                tags "Monitoring"
                properties {
                    "path" "apps/ops-console"
                    "horizon.intention" "运维启停，非 IM 对话"
                    "horizon.in" "操作者浏览器"
                    "horizon.out" "本机服务启停与日志"
                }
            }

            performanceDashboard = container "Performance Dashboard" "工人与工作台只读视图" "Vite apps/dashboard" {
                tags "Monitoring"
                properties {
                    "path" "apps/dashboard"
                    "horizon.intention" "只读查看正在干活的工人"
                    "horizon.in" "HTTP"
                    "horizon.out" "图表与列表"
                }
            }
        }

        // ── L1（用户只经 IM；监控走 ops/dashboard）────────────────
        user -> discord "使用 Discord 客户端" "Discord 桌面/移动客户端" {
            tags "http,ws"
        }
        user -> feishu "使用飞书客户端" "飞书桌面/移动客户端" {
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
        feishu -> kuroneko "入站消息 / 事件（多连接）" "长连接/Webhook" {
            tags "ws,http"
        }
        kuroneko -> feishu "出站回复 / reaction Typing" "HTTPS" {
            tags "http"
        }
        localWebChatIm -> kuroneko "ChatIR 入站、StructuredReply 出站" "HTTP/WS" {
            tags "http,ws"
        }
        kuroneko -> localWebChatIm "经 bridge 推送回复" "HTTP/WS" {
            tags "http,ws"
        }
        operator -> brainMonitoring "查看工人与工作台" "HTTPS" {
            tags "http"
        }
        brainMonitoring -> kuroneko "拉取 /inner-brains" "HTTPS" {
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

        // ── L2 飞书路径（✅ P2b；见 IDENTITY-CROSS-CHANNEL §5）────────
        feishu -> kuroneko.feishuBridge "im.message.receive 等" "长连接" {
            tags "ws"
        }
        kuroneko.feishuBridge -> kuroneko.chatIrLib "resolve(channel_key) + seenTracker" "npm import" {
            tags "import"
        }
        kuroneko.feishuBridge -> kuroneko.agentServer "ChatIRInboundEvent（canonical sid）" "in-process" {
            tags "import"
        }
        kuroneko.agentServer -> kuroneko.feishuBridge "postMessage / sendActivity(Typing reaction)" "in-process" {
            tags "import"
        }
        kuroneko.feishuBridge -> feishu "messages + reactions" "HTTPS" {
            tags "http"
        }

        // ── L2 微信 iLink 路径（✅ P4b；见 IDENTITY-CROSS-CHANNEL §6.6）────────
        wechat -> kuroneko.wechatBridge "getupdates 长轮询 msgs" "HTTPS" {
            tags "http"
        }
        kuroneko.wechatBridge -> kuroneko.chatIrLib "resolve(channel_key) + seenTracker" "npm import" {
            tags "import"
        }
        kuroneko.wechatBridge -> kuroneko.agentServer "ChatIRInboundEvent（canonical sid）" "in-process" {
            tags "import"
        }
        kuroneko.agentServer -> kuroneko.wechatBridge "postMessage / sendActivity(sendtyping)" "in-process" {
            tags "import"
        }
        kuroneko.wechatBridge -> wechat "sendmessage（context_token）" "HTTPS" {
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
        kuroneko.performanceDashboard -> kuroneko.agentServer "/inner-brains" "HTTPS" {
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
        kuroneko.agentServer.outerBrainFacade -> kuroneko.agentServer.agentStatusChatCommand "整句状态快指令（对话 LLM 前短路）" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.agentStatusChatCommand -> kuroneko.agentServer.innerBrainRegistry "只读任务状态时间线" "in-process" {
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
        kuroneko.agentServer.outerConversationLoop -> kuroneko.agentServer.emptyPromiseReconcile "shouldReconcileEmptyPromise / recovery prompt" "in-process" {
            tags "Relation"
        }
        kuroneko.agentServer.outerConversationLoop -> kuroneko.agentServer.outerToolExecutor "executeOuterTool" "in-process" {
            tags "import"
        }
        // 工具 → 派工
        kuroneko.agentServer.outerToolExecutor -> kuroneko.agentServer.innerBrainRegistry "register / list / stop" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.outerToolExecutor -> kuroneko.agentServer.workspaceInbox "set_goal：上班读其他工作台日志" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.workspaceInbox -> kuroneko.agentServer.innerBrainRegistry "list/get sibling TaskRecord" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.outerToolExecutor -> kuroneko.agentServer.innerSpawner "set_goal → spawn worker（新 workspace）" "child_process" {
            tags "spawn"
        }
        kuroneko.agentServer.outerToolExecutor -> kuroneko.agentServer.completionNotify "onExit DONE → 通知用户" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.outerToolExecutor -> kuroneko.agentServer.innerBurstExit "countDeliverables on onExit" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.outerToolExecutor -> kuroneko.agentServer.memoryBlockStore "memory_block_* list/put/bind" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.outerToolExecutor -> kuroneko.agentServer.identityLinkService "identity_link_request / status（不直接改映射）" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.outerToolExecutor -> kuroneko.agentServer.channelConnectionRegistry "feishu_channel_add/list/remove" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.identityLinkService -> kuroneko.chatIrLib "linkMerge / resolve via identityBindingIndex" "npm import" {
            tags "import"
        }
        kuroneko.agentServer.identityLinkService -> kuroneko.agentServer.outerBrainFacade "投递确认消息（经 imClient Fan-in）" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.channelConnectionRegistry -> kuroneko.agentServer.memoryBlockStore "secret_ref → keychain" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.channelConnectionRegistry -> kuroneko.feishuBridge "createFeishuConnector.connect / destroy" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.channelConnectionRegistry -> kuroneko.wechatBridge "createWechatConnector.connect / destroy" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.outerBrainFacade -> kuroneko.chatIrLib "入站 sender 经 identityBindingIndex.resolve" "npm import" {
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
        kuroneko.innerWorker.piMonoScheduler -> kuroneko.innerWorker.playSession "INNER_PLAY_MODE" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.playSession -> kuroneko.innerWorker.innerRuntimeFactory "createInnerRuntime" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.piMonoScheduler -> kuroneko.innerWorker.innerRuntimeFactory "createInnerRuntime" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.singleNodeBaseline -> kuroneko.innerWorker.runner "runLocalDag（一节点）" "in-process" {
            tags "import"
        }

        // ── DyFlow engine ────────────────────────────────────────────────
        kuroneko.innerWorker.controllerFsm -> kuroneko.innerWorker.designer "mode=DESIGN" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.controllerFsm -> kuroneko.innerWorker.runner "mode=RUN" "in-process" {
            tags "import"
        }

        // ── Inner Harness-RSI（自改 → 门控 → 升级/回退 → restart-with-H）────────
        kuroneko.innerWorker.harnessRevise -> kuroneko.innerWorker.harnessSpecStore "put draft H′" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.harnessGate -> kuroneko.innerWorker.harnessSpecStore "read H′ / parent" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.harnessPointer -> kuroneko.innerWorker.harnessSpecStore "resolve active id" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.harnessGate -> kuroneko.innerWorker.harnessPointer "upgrade only if gated_ok" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.harnessRestart -> kuroneko.innerWorker.harnessPointer "read active after upgrade/rollback" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.harnessRestart -> kuroneko.innerWorker.controllerFsm "re-enter DESIGN|RUN under H" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.controllerFsm -> kuroneko.innerWorker.harnessRevise "ATTRIBUTE/显式触发 revise（⏳）" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.runner -> kuroneko.innerWorker.harnessPointer "load active H refs（⏳）" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.workflowRunner -> kuroneko.innerWorker.harnessPointer "prefer active workflowRef（⏳）" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.controllerFsm -> kuroneko.innerWorker.harnessRsiCycle "ATTRIBUTE 后 RSI（周期为主；失败辅）" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.harnessRsiCycle -> kuroneko.innerWorker.harnessAnalyze "cadence / fail → analyze" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.harnessAnalyze -> kuroneko.innerWorker.harnessPointer "read active for baseline" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.harnessRsiCycle -> kuroneko.innerWorker.harnessRevise "revise from findings" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.harnessRsiCycle -> kuroneko.innerWorker.harnessGate "gate" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.harnessRsiCycle -> kuroneko.innerWorker.harnessPointer "upgrade" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.harnessRsiCycle -> kuroneko.innerWorker.harnessRestart "request restart-with-H" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.controllerFsm -> kuroneko.innerWorker.harnessAutoHeldOut "ATTRIBUTE 成功后自动 held-out" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.harnessAutoHeldOut -> kuroneko.innerWorker.harnessHeldOut "runHeldOutGate if no pass" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.harnessDrive9Sync -> kuroneko.innerWorker.harnessHeldOut "require held-out pass" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.harnessW15Dedup -> kuroneko.innerWorker.harnessPointer "active covering workflow?" "in-process" {
            tags "import"
        }

        // ── 工具 MDL 自生长（内核冻结；造工具=压缩题）─────────────────────────
        kuroneko.innerWorker.reactKernel -> kuroneko.innerWorker.toolIndex "读 tools/ 构建词汇表（M2）" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.reactKernel -> kuroneko.innerWorker.actionLog "append TraceRecord（M3/M10）" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.toolIndex -> kuroneko.innerWorker.toolManifest "解析校验（M7/M9）" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.traceMiner -> kuroneko.innerWorker.actionLog "读语料" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.traceMiner -> kuroneko.innerWorker.toolIndex "重编码用当前库（M8）" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.mdlAccount -> kuroneko.innerWorker.toolIndex "文法代价" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.mdlAccount -> kuroneko.innerWorker.actionLog "语料代价" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.growthCycle -> kuroneko.innerWorker.traceMiner "候选生成（机械）" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.growthCycle -> kuroneko.innerWorker.toolReplayGate "重放验收（M5）" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.growthCycle -> kuroneko.innerWorker.mdlAccount "ΔL 收录/退役（M4/M6）" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.growthCycle -> kuroneko.innerWorker.toolLibrary "写 tools/ · .mdl.json" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.toolLibrary -> kuroneko.innerWorker.toolManifest "manifest 契约" "in-process" {
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
        kuroneko.innerWorker.designerToolRegistry -> kuroneko.innerWorker.localNodeStore "list / read / promote_local_node commit" "in-process" {
            tags "import"
        }
        kuroneko.innerWorker.designerToolRegistry -> kuroneko.innerWorker.nodeAbstractor "fire-and-forget on promote_local_node" "in-process" {
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
        kuroneko.agentServer.innerWorkspaceRetention -> kuroneko.agentServer.innerBrainRegistry "remove terminal + rm workDir" "in-process" {
            tags "Inner-Lifecycle"
        }
        kuroneko.agentServer.nodeDefEviction -> kuroneko.agentServer.nodeDefDrive9Store "list/tombstone NodeDef" "HTTPS" {
            tags "http"
        }
        kuroneko.innerWorker.controllerFsm -> kuroneko.innerWorker.archiveStore "archive session" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.innerSpawner -> kuroneko.innerWorker.workerHost "workDir + env" "child_process" {
            tags "spawn"
        }

        // ── L3 外脑：用量与定时 ───────────────────────────────────
        kuroneko.agentServer.llmUsageTracker -> kuroneko.agentServer.llmGateway "wrap chat/completions" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.llmUsageTracker -> kuroneko.agentServer.llmUsageJournal "persist usage entries" "in-process" {
            tags "import"
        }

        // ── L3 外脑：用量 ─────────────────────────────────────────

    }

    views {
        systemContext kuroneko "01-L1-SystemContext" {
            include user operator discord feishu localWebChatIm brainMonitoring kuroneko llm mem9 drive9
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

        container kuroneko "03b-L2-Feishu-path" {
            title "L2 飞书路径（多连接 + resolve）"
            include user feishu kuroneko.feishuBridge kuroneko.chatIrLib kuroneko.agentServer
            autolayout lr
        }

        container kuroneko "03c-L2-WeChat-path" {
            title "L2 微信 iLink 路径（扫码登录 + 长轮询）"
            include user wechat kuroneko.wechatBridge kuroneko.chatIrLib kuroneko.agentServer
            autolayout lr
        }

        container kuroneko "04-L2-WebChat-path" {
            include user kuroneko.webChat kuroneko.chatServer kuroneko.webchatProtocolLib kuroneko.webchatBridge kuroneko.chatIrLib kuroneko.agentServer kuroneko.workspaceKit kuroneko.innerWorker
            autolayout tb
        }

        container kuroneko "05-L2-Libraries" {
            include kuroneko.chatIrLib kuroneko.workspaceKit kuroneko.webchatProtocolLib kuroneko.agentServer kuroneko.discordBridge kuroneko.webchatBridge kuroneko.feishuBridge kuroneko.wechatBridge kuroneko.chatServer kuroneko.webChat
            autolayout lr
        }

        component kuroneko.agentServer "06-L3-Outer-AllModules" {
            include element.tag==Outer-Module
            autolayout tb
        }

        component kuroneko.agentServer "07-L3-Outer-Inbound-IM" {
            title "L3 Outer — IM 入站（Facade 路径）"
            include kuroneko.agentServer.outerBrainFacade kuroneko.agentServer.agentStatusChatCommand kuroneko.agentServer.imIntentClassifier kuroneko.agentServer.awaitingInboundResolver kuroneko.agentServer.innerBrainRegistry kuroneko.agentServer.threadOrchestrator kuroneko.agentServer.knowledgeRetrieval kuroneko.agentServer.outerMemory kuroneko.agentServer.memoryBlockStore kuroneko.agentServer.participationPolicy kuroneko.agentServer.llmGateway kuroneko.agentServer.outerConversationLoop kuroneko.agentServer.outerToolExecutor kuroneko.agentServer.identityLinkService kuroneko.agentServer.channelConnectionRegistry
            autolayout tb
        }

        component kuroneko.agentServer "07c-L3-Outer-Identity-Link" {
            title "L3 Outer — 跨渠道身份认同 + 通道注册"
            include kuroneko.agentServer.identityLinkService kuroneko.agentServer.channelConnectionRegistry kuroneko.agentServer.outerToolExecutor kuroneko.agentServer.memoryBlockStore kuroneko.agentServer.outerBrainFacade
            autolayout lr
        }

        component kuroneko.agentServer "07b-L3-Outer-Inbound-HTTP" {
            title "L3 Outer — HTTP 入站（与 Facade 同路径）"
            include kuroneko.agentServer.outerBrainFacade kuroneko.agentServer.participationPolicy kuroneko.agentServer.outerConversationLoop kuroneko.agentServer.outerToolExecutor kuroneko.agentServer.structuredReplyParts
            autolayout lr
        }

        component kuroneko.agentServer "08-L3-Outer-Inner-Lifecycle" {
            title "L3 Outer — 派工、上班读日志、台上等待"
            include kuroneko.agentServer.outerToolExecutor kuroneko.agentServer.innerBrainRegistry kuroneko.agentServer.workspaceInbox kuroneko.agentServer.brainAsyncSnapshot kuroneko.agentServer.innerBurstExit kuroneko.agentServer.innerSpawner kuroneko.agentServer.completionNotify kuroneko.agentServer.pushLoop kuroneko.innerWorker.workerHost
            autolayout tb
        }

        component kuroneko.innerWorker "09-L3-Inner-Phases" {
            title "L3 内脑 — DyFlow Phases (DESIGN/RUN/AWAITING/DONE)"
            include element.tag==Inner-Phase element.tag==Inner-Scheduler element.tag==Inner-Tools kuroneko.innerWorker.controllerFsm kuroneko.innerWorker.brainFs kuroneko.innerWorker.archiveStore kuroneko.innerWorker.workerHost kuroneko.innerWorker.piMonoScheduler kuroneko.innerWorker.workdirGuard kuroneko.innerWorker.innerFileTools
            autolayout tb
        }

        component kuroneko.innerWorker "09b-L3-Inner-DyFlow" {
            title "L3 内脑 — DyFlow（designer/runner/baseNode + promote_local_node + LocalNode/Memory + Abstractor/Assembler）"
            include kuroneko.innerWorker.controllerFsm kuroneko.innerWorker.designer kuroneko.innerWorker.runner kuroneko.innerWorker.baseNodeExecutor kuroneko.innerWorker.localNodeStore kuroneko.innerWorker.memoryStore kuroneko.innerWorker.designerToolRegistry kuroneko.innerWorker.presetSeeder kuroneko.innerWorker.nodeAbstractor kuroneko.innerWorker.nodeAssembler kuroneko.innerWorker.innerFileTools kuroneko.innerWorker.workerHost kuroneko.innerWorker.piMonoScheduler kuroneko.agentServer.llmGateway kuroneko.agentServer.nodeDefDrive9Store
            autolayout tb
        }

        component kuroneko.innerWorker "09c-L3-Inner-Harness-RSI" {
            title "L3 内脑 — Harness-RSI（revise → gate → upgrade/rollback → restart-with-H）"
            include kuroneko.innerWorker.harnessSpecStore kuroneko.innerWorker.harnessPointer kuroneko.innerWorker.harnessAnalyze kuroneko.innerWorker.harnessRevise kuroneko.innerWorker.harnessGate kuroneko.innerWorker.harnessRestart kuroneko.innerWorker.harnessRsiCycle kuroneko.innerWorker.harnessHeldOut kuroneko.innerWorker.harnessAutoHeldOut kuroneko.innerWorker.harnessDrive9Sync kuroneko.innerWorker.harnessW15Dedup kuroneko.innerWorker.controllerFsm kuroneko.innerWorker.runner kuroneko.innerWorker.workflowRunner kuroneko.innerWorker.workerHost
            autolayout tb
        }

        component kuroneko.innerWorker "09e-L3-Exec-Agent" {
            title "L3 内脑 — 最小 exec agent（pi-ai + 全量消息，工具只有 exec）"
            include kuroneko.innerWorker.execAgent
            autolayout tb
        }

        component kuroneko.innerWorker "09d-L3-Tool-MDL-Growth" {
            title "L3 内脑 — 工具 MDL 自生长（冻结 ReAct 内核 + 离线文法归纳长工具）"
            include kuroneko.innerWorker.reactKernel kuroneko.innerWorker.toolIndex kuroneko.innerWorker.toolManifest kuroneko.innerWorker.actionLog kuroneko.innerWorker.traceMiner kuroneko.innerWorker.mdlAccount kuroneko.innerWorker.toolReplayGate kuroneko.innerWorker.toolLibrary kuroneko.innerWorker.growthCycle
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

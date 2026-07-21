workspace "Kuroneko" "ADL authority: L1-L2 integration + L3 agentServer modules. Horizon props: horizon.intention|in|out|deps. Tags: http|ws|spawn|file|import." {

    !identifiers hierarchical

    model {
        user = person "用户" "仅经 IM 渠道对话与派任务；不直连 Agent API"

        operator = person "运维/观察者" "ops-console、performance dashboard；查看内外脑与 KPI"

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
        kuroneko.agentServer.outerBrainFacade -> kuroneko.agentServer.agentStatusChatCommand "整句状态快指令（对话 LLM 前短路）" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.agentStatusChatCommand -> kuroneko.agentServer.innerBrainRegistry "只读任务状态时间线" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.agentStatusChatCommand -> kuroneko.agentServer.kpiRegistry "只读 active KPI 与任务归属" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.agentStatusChatCommand -> kuroneko.agentServer.autonomyPolicyStore "读取 maxRunningInnerBrains" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.outerBrainFacade -> kuroneko.agentServer.inboundKpiRouter "Step 3.4 只读上下文装配（不派发，注入 inboundHint）" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.inboundKpiRouter -> kuroneko.agentServer.kpiRegistry "active KPI 只读上下文（去重提示）" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.inboundKpiRouter -> kuroneko.agentServer.innerBrainRegistry "在跑 burst 只读上下文（供 LLM send_directive）" "in-process" {
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
        // 工具 → 内脑 / KPI / 通知
        kuroneko.agentServer.outerToolExecutor -> kuroneko.agentServer.innerBrainRegistry "register / list / stop" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.outerToolExecutor -> kuroneko.agentServer.innerBrainKpiReuse "set_goal output → isSetGoalDispatched" "in-process" {
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
        kuroneko.agentServer.outerToolExecutor -> kuroneko.agentServer.innerSpawner "set_goal → spawn worker（新 workspace）" "child_process" {
            tags "spawn"
        }
        kuroneko.agentServer.outerToolExecutor -> kuroneko.agentServer.awaitingNotify "onExit AWAITING → 等人类 IM" "in-process" {
        }
        kuroneko.agentServer.outerToolExecutor -> kuroneko.agentServer.completionNotify "onExit DONE → 通知用户" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.outerToolExecutor -> kuroneko.agentServer.innerBurstExit "countDeliverables on onExit" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.outerToolExecutor -> kuroneko.agentServer.kpiRegistry "set_kpi / view_kpi" "in-process" {
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
        kuroneko.agentServer.changeWatcher -> kuroneko.agentServer.brainAsyncSnapshot "read pendings snapshot per workDir" "in-process" {
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
        kuroneko.agentServer.outerHeartbeat -> kuroneko.agentServer.nodeDefEviction "tick sweep（P2）" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.nodeDefEviction -> kuroneko.agentServer.nodeDefDrive9Store "list/tombstone NodeDef" "HTTPS" {
            tags "http"
        }
        kuroneko.innerWorker.controllerFsm -> kuroneko.innerWorker.archiveStore "archive(kpiId)" "in-process" {
            tags "import"
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
        kuroneko.agentServer.outerHeartbeat -> kuroneko.agentServer.casualChatDispatcher "verdict=idle → 性格概率闲聊" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.casualChatDispatcher -> kuroneko.agentServer.agentPersonality "idleChatProbability" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.casualChatDispatcher -> kuroneko.agentServer.outerToolExecutor "post_to_im" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.casualChatDispatcher -> kuroneko.agentServer.participationPolicy "casual_chat 频控" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.casualChatDispatcher -> kuroneko.agentServer.kpiRegistry "defer when active KPI + can spawn" "in-process" {
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
        kuroneko.agentServer.outerHeartbeat -> kuroneko.agentServer.environmentModelFacade "collectEnvironmentSnapshot + journal" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.environmentModelFacade -> kuroneko.agentServer.environmentSensorRegistry "registry.collect()" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.environmentModelFacade -> kuroneko.agentServer.environmentJournal "snapshot + events persist" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.autonomyJudge -> kuroneko.agentServer.environmentModelFacade "toResourceSnapshot → hardGates" "in-process" {
            tags "import"
        }

        // ── L3 外脑：KPI 管理器（取代战略规划层心跳路径）────────────
        kuroneko.agentServer.outerHeartbeat -> kuroneko.agentServer.kpiManager "watchdog tick：R3–R7/reap + 兼容 advance fallback" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.kpiManager -> kuroneko.agentServer.kpiSpawnCapacity "evaluateKpiSpawnCapacity(facets)" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.kpiManager -> kuroneko.agentServer.autonomyPolicyStore "hardGates + kpi_inner_goal task policy" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.kpiAdvancer -> kuroneko.agentServer.kpiSpawnCapacity "resolveSystemCapacity(facets, R2 parallel)" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.kpiSpawnCapacity -> kuroneko.agentServer.autonomyPolicyStore "hardGates.maxRunningInnerBrains / maxLlmInFlight …" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.kpiManager -> kuroneko.agentServer.kpiRegistry "active KPIs + burstRunHistory" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.kpiManager -> kuroneko.agentServer.innerBrainRegistry "reap ABORTED + burst states" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.kpiManager -> kuroneko.agentServer.kpiAdvancer "EnvironmentSnapshot + policy → advanceKpi" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.kpiManager -> kuroneko.agentServer.kpiFailureCircuit "R7 每 tick 续派前 trip（pause + IM 通知）" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.kpiFailureCircuit -> kuroneko.agentServer.kpiRegistry "pause(kpiId, reason)" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.kpiManager -> kuroneko.agentServer.outerToolExecutor "兼容 fallback：set_goal(kpi_id)" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.innerBurstExit -> kuroneko.agentServer.digitalEmployeeLoop "burst_finished → trigger（释放容量后立即找活）" "in-process" {
            tags "event"
        }
        kuroneko.agentServer.changeWatcher -> kuroneko.agentServer.digitalEmployeeLoop "dependency_resolved → trigger" "in-process" {
            tags "event"
        }
        kuroneko.agentServer.employeeCalendar -> kuroneko.agentServer.digitalEmployeeLoop "calendar_due → trigger；due 保留至有容量" "in-process" {
            tags "event"
        }
        kuroneko.agentServer.outerHeartbeat -> kuroneko.agentServer.digitalEmployeeLoop "heartbeat_fallback（watchdog 补漏）" "in-process" {
            tags "event"
        }
        kuroneko.agentServer.digitalEmployeeLoop -> kuroneko.agentServer.environmentModelFacade "collect EnvironmentSnapshot" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.digitalEmployeeLoop -> kuroneko.agentServer.autonomyJudge "hasAvailableCapacity" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.digitalEmployeeLoop -> kuroneko.agentServer.employeeCalendar "read due commitments first" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.digitalEmployeeLoop -> kuroneko.agentServer.selfWorkPolicy "无 due 且有容量 → propose" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.selfWorkPolicy -> kuroneko.agentServer.kpiRegistry "active KPI + momentum/history" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.selfWorkPolicy -> kuroneko.agentServer.innerBrainRegistry "pending dependencies + running conflicts" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.digitalEmployeeLoop -> kuroneko.agentServer.outerToolExecutor "合法日程/提案 → 唯一 set_goal" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.environmentSensorRegistry -> kuroneko.agentServer.employeeCalendar "calendar sensor 只读 due/missed" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.staleBurstReaper -> kuroneko.agentServer.awaitingInboundResolver "peekPendingMatch（避免杀正在收敛）" "in-process" {
            tags "import"
        }
        kuroneko.agentServer.staleBurstReaper -> kuroneko.innerWorker.archiveStore "archive(workDir, abortReason)" "file" {
            tags "file"
        }
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
            include kuroneko.agentServer.outerBrainFacade kuroneko.agentServer.agentStatusChatCommand kuroneko.agentServer.inboundKpiRouter kuroneko.agentServer.imIntentClassifier kuroneko.agentServer.awaitingInboundResolver kuroneko.agentServer.innerBrainRegistry kuroneko.agentServer.threadOrchestrator kuroneko.agentServer.knowledgeRetrieval kuroneko.agentServer.outerMemory kuroneko.agentServer.memoryBlockStore kuroneko.agentServer.participationPolicy kuroneko.agentServer.llmGateway kuroneko.agentServer.outerConversationLoop kuroneko.agentServer.kpiAdvancer kuroneko.agentServer.kpiRegistry kuroneko.agentServer.autonomyPolicyStore kuroneko.agentServer.outerToolExecutor kuroneko.agentServer.identityLinkService kuroneko.agentServer.channelConnectionRegistry
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
            title "L3 Outer — 内脑 spawn / AWAITING 唤醒 / 通知 / KPI"
            include kuroneko.agentServer.outerToolExecutor kuroneko.agentServer.innerBrainRegistry kuroneko.agentServer.innerBrainKpiReuse kuroneko.agentServer.workspaceInbox kuroneko.agentServer.brainAsyncSnapshot kuroneko.agentServer.innerBurstExit kuroneko.agentServer.innerSpawner kuroneko.agentServer.changeWatcher kuroneko.agentServer.imNotifyDedup kuroneko.agentServer.awaitingNotify kuroneko.agentServer.completionNotify kuroneko.agentServer.pushLoop kuroneko.agentServer.kpiRegistry kuroneko.innerWorker.workerHost
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

        container kuroneko "10-L2-KPI-Closed-Loop" {
            title "KPI 闭环（agentServer ↔ innerWorker + 共享 workDir）"
            include kuroneko.agentServer kuroneko.innerWorker
            autolayout tb
        }

        component kuroneko.agentServer "10b-L3-Outer-KPI" {
            title "L3 外脑 — KPI 调度与 onExit"
            include kuroneko.agentServer.kpiRegistry kuroneko.agentServer.kpiManager kuroneko.agentServer.kpiAdvancer kuroneko.agentServer.kpiFailureCircuit kuroneko.agentServer.kpiSpawnCapacity kuroneko.agentServer.autonomyPolicyStore kuroneko.agentServer.kpiCompletionJudge kuroneko.agentServer.innerBrainKpiReuse kuroneko.agentServer.outerToolExecutor kuroneko.agentServer.innerBrainRegistry kuroneko.agentServer.workspaceInbox kuroneko.agentServer.innerSpawner kuroneko.agentServer.innerBurstExit
            autolayout tb
        }

        component kuroneko.agentServer "11-L3-Outer-Autonomy" {
            title "L3 外脑 — 数字员工自主工作（容量+日程+创造性提案；心跳 watchdog）"
            include kuroneko.agentServer.outerHeartbeat kuroneko.agentServer.digitalEmployeeLoop kuroneko.agentServer.employeeCalendar kuroneko.agentServer.selfWorkPolicy kuroneko.agentServer.kpiCompletionJudge kuroneko.agentServer.resourceProbe kuroneko.agentServer.llmUsageTracker kuroneko.agentServer.autonomyPolicyStore kuroneko.agentServer.agentPersonality kuroneko.agentServer.autonomyJudge kuroneko.agentServer.casualChatDispatcher kuroneko.agentServer.performanceGoalEngine kuroneko.agentServer.outerToolExecutor kuroneko.agentServer.participationPolicy kuroneko.agentServer.kpiRegistry kuroneko.agentServer.innerBrainRegistry kuroneko.agentServer.threadOrchestrator kuroneko.agentServer.llmGateway kuroneko.agentServer.outerConversationLoop
            autolayout tb
        }

        component kuroneko.agentServer "12-L3-Outer-Environment" {
            title "L3 外脑 — 环境模型（sensor registry / journal / change detector / 消费方）"
            include kuroneko.agentServer.environmentSensorRegistry kuroneko.agentServer.environmentModelFacade kuroneko.agentServer.environmentJournal kuroneko.agentServer.environmentChangeDetector kuroneko.agentServer.kpiSpawnCapacity kuroneko.agentServer.autonomyPolicyStore kuroneko.agentServer.outerHeartbeat kuroneko.agentServer.autonomyJudge kuroneko.agentServer.digitalEmployeeLoop kuroneko.agentServer.employeeCalendar kuroneko.agentServer.selfWorkPolicy kuroneko.agentServer.kpiManager kuroneko.agentServer.kpiAdvancer kuroneko.agentServer.innerBrainRegistry kuroneko.agentServer.llmUsageJournal kuroneko.agentServer.threadOrchestrator
            autolayout tb
        }

        component kuroneko.agentServer "13-L3-Outer-KPI-Manager" {
            title "L3 外脑 — KPI 治理（R3–R7/reap；advance 兼容 fallback）"
            include kuroneko.agentServer.outerHeartbeat kuroneko.agentServer.environmentSensorRegistry kuroneko.agentServer.environmentModelFacade kuroneko.agentServer.kpiSpawnCapacity kuroneko.agentServer.autonomyPolicyStore kuroneko.agentServer.kpiManager kuroneko.agentServer.kpiAdvancer kuroneko.agentServer.kpiFailureCircuit kuroneko.agentServer.casualChatDispatcher kuroneko.agentServer.kpiRegistry kuroneko.agentServer.environmentJournal kuroneko.agentServer.innerBrainRegistry kuroneko.agentServer.awaitingInboundResolver kuroneko.agentServer.outerToolExecutor kuroneko.innerWorker.archiveStore
            autolayout tb
        }

        component kuroneko.agentServer "14-L3-Digital-Employee-Loop" {
            title "L3 外脑 — 数字员工容量驱动循环（日程优先 + SelfWorkPolicy）"
            include kuroneko.agentServer.digitalEmployeeLoop kuroneko.agentServer.employeeCalendar kuroneko.agentServer.selfWorkPolicy kuroneko.agentServer.environmentSensorRegistry kuroneko.agentServer.environmentModelFacade kuroneko.agentServer.autonomyJudge kuroneko.agentServer.autonomyPolicyStore kuroneko.agentServer.kpiRegistry kuroneko.agentServer.kpiManager kuroneko.agentServer.innerBrainRegistry kuroneko.agentServer.innerBurstExit kuroneko.agentServer.changeWatcher kuroneko.agentServer.outerHeartbeat kuroneko.agentServer.outerToolExecutor
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

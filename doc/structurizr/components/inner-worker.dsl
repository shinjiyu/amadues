                workerHost = component "Worker Host" "子进程入口、status.json、tick 循环" "TypeScript" {
                    tags "Inner-Module"
                    properties {
                        "path" "packages/server/src/pi-mono/inner-brain-worker.ts"
                        "horizon.in" "INNER_* env"
                        "horizon.out" ".run/inner-worker-status.json; pi-mono output"
                        "horizon.test.integration" "workerHost.component.integration.test.ts"
                    }
                }

                piMonoScheduler = component "Pi-mono Scheduler" "run-tick：DyFlow Controller.tick；INNER_PLAY_MODE 时改走 playSession" "TypeScript" {
                    tags "Inner-Module"
                    properties {
                        "path" "packages/server/src/pi-mono/run-tick.ts"
                        "horizon.test.integration" "piMonoScheduler.component.integration.test.ts"
                    }
                }

                playSession = component "Play Session" "玩耍模式的一条工具循环，跑在 @earendil-works/pi-agent-core。不经过 Designer" "TypeScript" {
                    tags "Inner-Module"
                    properties {
                        "path" "packages/server/src/pi-mono/play-loop.ts"
                        "horizon.in" "workspaceId + workDir + INNER_PLAY_MODE"
                        "horizon.out" ".run/pi-mono/play.jsonl; .brain/play-context.md"
                        "horizon.deps" "pi-agent-core; innerRuntimeFactory; memoryStore"
                        "horizon.test.unit" "play-loop.test.ts"
                    }
                }

                innerRuntimeFactory = component "Inner Runtime Factory" "【⏳】构造内脑运行时依赖：LLM、executor 工具表、logger、技能、drive9、plan reference" "TypeScript" {
                    tags "Inner-Module"
                    properties {
                        "path" "packages/server/src/pi-mono/inner-runtime.ts"
                        "horizon.intention" "run-tick 与消融基线共用同一份依赖，保证两臂工具表一致"
                        "horizon.in" "workspaceId + workDir + process.env"
                        "horizon.out" "InnerRuntime { llm, toolRegistry, logger, skillProvider, nodeSharing?, sharedFactSink?, planReference }"
                        "horizon.test.unit" "inner-runtime.test.ts"
                        "horizon.note" "见 INNER-ABLATION.md §9"
                    }
                }

                singleNodeBaseline = component "Single-Node Baseline" "【⏳】消融基线：固定一节点 DAG（preset/base，instruction=goal）交给 Runner；无 Designer/Attributor/重设计" "TypeScript" {
                    tags "Inner-Module" "Ablation"
                    properties {
                        "path" "packages/server/src/openkuroneko/inner-brain/single-node-baseline.ts"
                        "horizon.intention" "回答「DyFlow 编排层是否必要」：同模型同工具同验票，只去掉编排"
                        "horizon.in" "workDir（.brain/goal.md）+ llm + toolRegistry"
                        "horizon.out" ".run/single-node-baseline.json; memory.node_results.single"
                        "horizon.deps" "runner; localNodeStore; memoryStore; presetSeeder"
                        "horizon.test.integration" "singleNodeBaseline.component.integration.test.ts"
                        "horizon.note" "仅实验用，生产不调用；见 INNER-ABLATION.md"
                    }
                }

                controllerFsm = component "Controller FSM" "DyFlow mode 切换：DESIGN|RUN|AWAITING|DONE" "TypeScript" {
                    tags "Inner-Module" "Inner-Scheduler"
                    properties {
                        "path" "packages/server/src/openkuroneko/inner-brain/controller.ts"
                        "horizon.in" "tick()"
                        "horizon.out" "hadWork; mode 转移"
                        "horizon.test.integration" "controllerFsm.component.integration.test.ts"
                        "horizon.note" "DyFlow 单引擎；旧三件套已删除，见 DYFLOW-INNER-EXECUTOR.md"
                    }
                }

                // ── DyFlow engine ─────────────────────────────────────────────────────
                designer = component "Designer (DyFlow)" "DESIGN 阶段：LLM 编排 local_dag；读 memory + last_failure + LocalNode index；调 Designer Tools" "TypeScript" {
                    tags "Inner-Module" "Inner-Phase" "DyFlow-Phase" "Planned"
                    properties {
                        "path" "packages/server/src/openkuroneko/inner-brain/designer.ts"
                        "horizon.intention" "DESIGN 阶段：每 tick 重规划 NodeInst[]，输出 local_dag.json 或 DONE"
                        "horizon.in" "goal + memory + memory.last_failure + localNodeStore.index"
                        "horizon.out" "local_dag.json | report_done | wait/ask"
                        "horizon.deps" "designerToolRegistry; llmGateway"
                        "horizon.test.integration" "designer.component.integration.test.ts"
                        "horizon.test.prompt" "designer.prompt.test.ts"
                        "horizon.note" "见 DYFLOW-INNER-EXECUTOR.md §3 §6.3"
                    }
                }

                runner = component "Runner (DyFlow)" "RUN 阶段：解析 local_dag，按 NodeInst 派发 baseNode / graph；写 memory.node_results & last_failure" "TypeScript" {
                    tags "Inner-Module" "Inner-Phase" "DyFlow-Phase" "Planned"
                    properties {
                        "path" "packages/server/src/openkuroneko/inner-brain/runner.ts"
                        "horizon.intention" "顺序/依边执行 local_dag；非 LLM 决策；terminal failure 上交 designer"
                        "horizon.in" "local_dag.json + LocalNode 库"
                        "horizon.out" "memory.node_results.<id>; memory.last_failure"
                        "horizon.deps" "baseNodeExecutor; localNodeStore; memoryStore"
                        "horizon.test.integration" "runner.component.integration.test.ts"
                    }
                }

                workflowRunner = component "Workflow Runner" "【⏳】execute 模式：按 Executable Workflow steps 逐步执行并机械验收" "TypeScript" {
                    tags "Inner-Module" "Executable-Workflow" "Planned-P0"
                    properties {
                        "path" "packages/server/src/openkuroneko/inner-brain/workflow-runner.ts"
                        "horizon.intention" "绑定 workflowRef；禁 redesign；逐步 expect；写 workflow_run.json"
                        "horizon.in" "ExecutableWorkflow@version + workDir"
                        "horizon.out" "step results · DONE|ERROR per failurePolicy"
                        "horizon.deps" "workflowKindAdapters; browserPlaybook; baseNodeExecutor(受限); memoryStore; harnessPointer"
                        "horizon.test.unit" "workflow-runner.test.ts"
                        "horizon.note" "见 EXECUTABLE-WORKFLOW.md §5–§7；Skill 仅为 kind 之一；优先读 active HarnessSpec.workflowRef"
                    }
                }

                // ── Inner Harness-RSI（自改 · 升级 · 回退；外脑不做 RSI）────────────────
                harnessSpecStore = component "Harness Spec Store" "【✅ P0】版本化 HarnessSpec：LocalNode/skill/EW/assets 快照；不可变 blob" "TypeScript" {
                    tags "Inner-Module" "Harness-RSI"
                    properties {
                        "path" "packages/server/src/openkuroneko/inner-brain/harness-spec-store.ts"
                        "horizon.intention" "H 可寻址；upgrade 只改指针不改历史 blob"
                        "horizon.in" "put draft · get by id · list"
                        "horizon.out" ".brain/harness/specs/<id>.json"
                        "horizon.deps" "filesystem workDir"
                        "horizon.test.unit" "harness-spec-store.test.ts"
                        "horizon.note" "见 HARNESS-RSI.md §5–§7；H1–H2"
                    }
                }

                harnessPointer = component "Harness Pointer" "【✅ P0】active.json + history；upgrade / rollback" "TypeScript" {
                    tags "Inner-Module" "Harness-RSI"
                    properties {
                        "path" "packages/server/src/openkuroneko/inner-brain/harness-pointer.ts"
                        "horizon.intention" "当前生效 H；失败保持旧版；审计 JSONL"
                        "horizon.in" "upgrade(H′) · rollback(prev) · readActive"
                        "horizon.out" ".brain/harness/active.json · history.jsonl"
                        "horizon.deps" "harnessSpecStore"
                        "horizon.test.unit" "harness-pointer.test.ts"
                        "horizon.note" "范型 BATTLE-TUNE-LOOP active.json；H3–H4"
                    }
                }

                harnessRevise = component "Harness Revise" "【✅】分析 run-context → 提案 H′；失败节点 skillRefs 优先（不可见评测 rubric）" "TypeScript" {
                    tags "Inner-Module" "Harness-RSI"
                    properties {
                        "path" "packages/server/src/openkuroneko/inner-brain/harness-revise.ts"
                        "horizon.intention" "局部自改：单 parent→单 H′；非蒙特卡罗种群"
                        "horizon.in" "active H + run-context + node-skill index"
                        "horizon.out" "HarnessSpec draft (parentId=active; skillRefs)"
                        "horizon.deps" "harnessSpecStore; harnessPointer; nodeSkillStore"
                        "horizon.test.unit" "harness-revise.test.ts"
                        "horizon.note" "H6：禁止 KPI judge / x_eval 进 prompt；见 HARNESS-RSI.md §4"
                    }
                }

                harnessGate = component "Harness Gate" "【✅ P1】机械 expect/回放；相对 parent 不回归才允许 upgrade" "TypeScript" {
                    tags "Inner-Module" "Harness-RSI"
                    properties {
                        "path" "packages/server/src/openkuroneko/inner-brain/harness-gate.ts"
                        "horizon.intention" "先回归再上线；fail → active 不变"
                        "horizon.in" "H′ vs parent · fixtures/expect"
                        "horizon.out" "gated_ok | gated_fail"
                        "horizon.deps" "harnessSpecStore; workflowRunner(expect 复用)"
                        "horizon.test.unit" "harness-gate.test.ts"
                        "horizon.note" "H3；范型 PSTune regression_gate"
                    }
                }

                harnessRestart = component "Harness Restart" "【✅ P1】切 active 后同 charter 再进 DESIGN→RUN（≠ 进程 resume）" "TypeScript" {
                    tags "Inner-Module" "Harness-RSI"
                    properties {
                        "path" "packages/server/src/openkuroneko/inner-brain/harness-restart.ts"
                        "horizon.intention" "restart-with-H：加载新 active 再跑；非 POST inner-brains restart"
                        "horizon.in" "harnessId after upgrade/rollback"
                        "horizon.out" "controller 重回 DESIGN|RUN under H"
                        "horizon.deps" "harnessPointer; controllerFsm"
                        "horizon.test.integration" "harnessRsi.component.integration.test.ts"
                        "horizon.note" "H7；见 HARNESS-RSI.md §3 restart-with-H"
                    }
                }

                harnessAnalyze = component "Harness Analyze" "【✅ P4】读 run-context/日志 → soft findings；管 cadence（类 pstune analyze）" "TypeScript" {
                    tags "Inner-Module" "Harness-RSI"
                    properties {
                        "path" "packages/server/src/openkuroneko/inner-brain/harness-analyze.ts"
                        "horizon.intention" "周期复盘：发现能跑但不合理的优化点；不直接改 active"
                        "horizon.in" "workDir · run-context · analyze-cadence.json"
                        "horizon.out" "findings[] · shouldRevise"
                        "horizon.deps" "harnessPointer"
                        "horizon.test.unit" "harness-analyze.test.ts"
                        "horizon.note" "H6/H9；见 HARNESS-RSI.md §4.1 · BATTLE-TUNE-LOOP pstune analyze"
                    }
                }

                harnessRsiCycle = component "Harness RSI Cycle" "【✅ P4】周期 analyze→revise→gate→upgrade；失败辅触发；封顶 2 轮/burst" "TypeScript" {
                    tags "Inner-Module" "Harness-RSI"
                    properties {
                        "path" "packages/server/src/openkuroneko/inner-brain/harness-rsi-cycle.ts"
                        "horizon.intention" "局部上升闭环；主=cadence 复盘，辅=hard fail"
                        "horizon.in" "runOk + rsiRound + cadence + run-context"
                        "horizon.out" "active 指针 / restart-requested"
                        "horizon.deps" "harnessAnalyze; harnessRevise; harnessGate; harnessPointer; harnessRestart"
                        "horizon.test.unit" "harness-rsi-cycle.test.ts"
                        "horizon.test.integration" "harnessRsi.component.integration.test.ts"
                        "horizon.note" "见 HARNESS-RSI.md §4 / §8 P4 / H9"
                    }
                }

                harnessHeldOut = component "Harness Held-Out" "【✅ P3】同类型 held-out charter 机械门控；写 .brain/harness/held-out/" "TypeScript" {
                    tags "Inner-Module" "Harness-RSI"
                    properties {
                        "path" "packages/server/src/openkuroneko/inner-brain/harness-held-out.ts"
                        "horizon.intention" "防过拟合：共享前须 held-out pass"
                        "horizon.in" "harnessId + expects/charter"
                        "horizon.out" "HeldOutVerdict"
                        "horizon.deps" "harnessSpecStore; checkExpect"
                        "horizon.test.unit" "harness-p3.test.ts"
                    }
                }

                harnessAutoHeldOut = component "Harness Auto Held-Out" "【✅】成功 RUN 后对 active H 自动跑 held-out（无 pass 时）" "TypeScript" {
                    tags "Inner-Module" "Harness-RSI"
                    properties {
                        "path" "packages/server/src/openkuroneko/inner-brain/harness-auto-held-out.ts"
                        "horizon.intention" "免手动 gate：成功轨迹即可解锁 drive9 闸"
                        "horizon.in" "workDir · active H"
                        "horizon.out" "HeldOutVerdict | null"
                        "horizon.deps" "harnessHeldOut; harnessPointer"
                        "horizon.test.unit" "harness-p3.test.ts"
                        "horizon.note" "controller ATTRIBUTE success 路径；已有 pass 则跳过"
                    }
                }

                harnessDrive9Sync = component "Harness Drive9 Sync Gate" "【✅ P3】active H 拥有 EW 时 promote→drive9 须 held-out" "TypeScript" {
                    tags "Inner-Module" "Harness-RSI"
                    properties {
                        "path" "packages/server/src/openkuroneko/inner-brain/harness-drive9-sync.ts"
                        "horizon.intention" "本地 put 不挡；共享池可拒"
                        "horizon.in" "workDir + workflowId@version"
                        "horizon.out" "maySync ok/reason"
                        "horizon.deps" "harnessHeldOut; harnessPointer"
                        "horizon.test.unit" "harness-p3.test.ts; workflow-promote.test.ts"
                    }
                }

                harnessW15Dedup = component "Harness W15 Dedup" "【✅ P3】内脑 RSI 已覆盖 EW 时抑制外脑 ew_revision" "TypeScript" {
                    tags "Inner-Module" "Harness-RSI"
                    properties {
                        "path" "packages/server/src/openkuroneko/inner-brain/harness-w15-dedup.ts"
                        "horizon.intention" "避免双修：SelfWork explore vs 内脑 restart-with-H"
                        "horizon.in" "workDir + workflowId"
                        "horizon.out" "covering bool → considerWorkflowEvolution skip"
                        "horizon.deps" "harnessPointer; harnessSpecStore"
                        "horizon.test.unit" "harness-p3.test.ts; workflow-evolution-policy.test.ts"
                    }
                }

                execAgent = component "Exec Agent" "【✅】act=exec±种子工具；reflect 仅 rule/skill；没收 create_tool；事后分析种子再跑" "TypeScript" {
                    tags "Inner-Module" "Exec-Agent"
                    properties {
                        "path" "packages/server/src/openkuroneko/exec-agent/loop.ts"
                        "horizon.intention" "能改仓库的基础循环；靠复用控制工具膨胀，暂不 retire 工具"
                        "horizon.in" "task + model + cwd"
                        "horizon.out" "Message[]；registeredTools；.agent/rules|skills；JEV 判完成才停"
                        "horizon.deps" "@earendil-works/pi-ai; JEV system-one"
                        "horizon.test.unit" "exec-agent/loop.test.ts"
                        "horizon.note" "不用 reactKernel。不截断历史。Reflect 无 create_tool，只 rule/skill。工具仅 .agent/tools.json 种子。见 EXEC-AGENT.md"
                    }
                }

                // ── 工具 MDL 自生长（TOOL-MDL-GROWTH.md）：内核冻结；造工具=压缩题 ──────
                // 与上方 Harness-RSI 的关系：替代设计。自改写不增可达性且不可验证。

                actionLog = component "Action Log" "【✅ P0】TraceRecord schema / append；argv[0] 符号抽取 + 参数规范化" "TypeScript" {
                    tags "Inner-Module" "Tool-MDL"
                    properties {
                        "path" "packages/server/src/openkuroneko/tool-mdl/action-log.ts"
                        "horizon.intention" "为外循环挖掘提供结构化语料；事后补不回来"
                        "horizon.in" "动作 + 观测 + token 计数"
                        "horizon.out" "TraceRecord[] → runs/<runId>/trace.jsonl"
                        "horizon.deps" "filesystem workDir"
                        "horizon.test.unit" "action-log.test.ts"
                        "horizon.note" "M3：args 必须结构化字典，字符串 blob 非法；M10 双项计费"
                    }
                }

                toolManifest = component "Tool Manifest" "【✅ P0】manifest 解析校验：描述 token 上限 / kind / args schema" "TypeScript" {
                    tags "Inner-Module" "Tool-MDL"
                    properties {
                        "path" "packages/server/src/openkuroneko/tool-mdl/tool-manifest.ts"
                        "horizon.intention" "工具接口契约；文法代价在接口层强制"
                        "horizon.in" "tools/<name>/manifest.json"
                        "horizon.out" "ToolManifest | ValidationError[]"
                        "horizon.deps" "—"
                        "horizon.test.unit" "tool-manifest.test.ts"
                        "horizon.note" "M7 描述 token 硬上限；M9 kind=acquisition 默认禁"
                    }
                }

                toolIndex = component "Tool Index" "【✅ P0】扫 tools/ → 内循环词汇表 + 文法代价计量" "TypeScript" {
                    tags "Inner-Module" "Tool-MDL"
                    properties {
                        "path" "packages/server/src/openkuroneko/tool-mdl/tool-index.ts"
                        "horizon.intention" "元层由内核固定约定提供：索引=tools/ 目录的函数，不是一个动作"
                        "horizon.in" "tools/ 目录"
                        "horizon.out" "ToolIndexEntry[] + grammarCostTokens"
                        "horizon.deps" "toolManifest"
                        "horizon.test.unit" "tool-index.test.ts"
                        "horizon.note" "M2；索引 token 每轮都付，对应 utility problem"
                    }
                }

                mdlAccount = component "MDL Account" "【✅ P0】文法/语料代价；收录与退役 ΔL；utility 拐点" "TypeScript" {
                    tags "Inner-Module" "Tool-MDL"
                    properties {
                        "path" "packages/server/src/openkuroneko/tool-mdl/mdl-account.ts"
                        "horizon.intention" "同一个目标函数同时管收录与退役"
                        "horizon.in" "library + corpus + 剩余步数预算 S"
                        "horizon.out" "ΔL(accept) · ΔL(retire) · crossoverStep"
                        "horizon.deps" "toolIndex; actionLog"
                        "horizon.test.unit" "mdl-account.test.ts"
                        "horizon.note" "M4/M6；ΔL<0 才收；见 TOOL-MDL-GROWTH.md §4.3"
                    }
                }

                traceMiner = component "Trace Miner" "【✅ P0】重编码 + 频繁子序列挖掘（min-support ∧ min-gain）" "TypeScript" {
                    tags "Inner-Module" "Tool-MDL"
                    properties {
                        "path" "packages/server/src/openkuroneko/tool-mdl/trace-miner.ts"
                        "horizon.intention" "候选生成机械化；模型不决定造不造"
                        "horizon.in" "TraceRecord[] + 当前 library + 阈值"
                        "horizon.out" "ToolCandidate[]（symbols · support · instances · gain）"
                        "horizon.deps" "actionLog; toolIndex"
                        "horizon.test.unit" "trace-miner.test.ts"
                        "horizon.note" "M8：挖掘前必须重编码，否则层级恒为 1；范型 SEQUITUR / BPE"
                    }
                }

                reactKernel = component "ReAct Kernel (frozen)" "【✅ P0】冻结内循环；单终结符 shell_exec；注入式 LLM/executor" "TypeScript" {
                    tags "Inner-Module" "Tool-MDL"
                    properties {
                        "path" "packages/server/src/openkuroneko/tool-mdl/react-kernel.ts"
                        "horizon.intention" "不可变解释器 + 可变数据；内核不读自己不写自己"
                        "horizon.in" "task + toolIndex + LlmPort + ExecutorPort + budget"
                        "horizon.out" "KernelResult + TraceRecord[]"
                        "horizon.deps" "toolIndex; actionLog"
                        "horizon.test.unit" "react-kernel.test.ts"
                        "horizon.note" "M1：内核源码不进 prompt；M2：A_prim={shell_exec}；观测有界"
                    }
                }

                toolReplayGate = component "Tool Replay Gate" "【✅ P1】拿 tests.jsonl 重放候选工具；不过不收" "TypeScript" {
                    tags "Inner-Module" "Tool-MDL"
                    properties {
                        "path" "packages/server/src/openkuroneko/tool-mdl/tool-replay-gate.ts"
                        "horizon.intention" "确定性、逐个可判定的验收；不需要 benchmark"
                        "horizon.in" "候选工具 + 挖掘实例 (args, expected)"
                        "horizon.out" "pass | fail(mismatch[])"
                        "horizon.deps" "toolManifest; ExecutorPort"
                        "horizon.test.unit" "tool-replay-gate.test.ts"
                        "horizon.note" "M5；夹具与工具同目录，构成永久回归"
                    }
                }

                toolLibrary = component "Tool Library" "【✅ P1】deps DAG；accept / retire 落盘与顺序约束" "TypeScript" {
                    tags "Inner-Module" "Tool-MDL"
                    properties {
                        "path" "packages/server/src/openkuroneko/tool-mdl/tool-library.ts"
                        "horizon.intention" "工具即文法；收录=加产生式，退役=删产生式"
                        "horizon.in" "ToolManifest + ΔL 判定"
                        "horizon.out" "tools/<name>/ 落盘 · .mdl.json history"
                        "horizon.deps" "toolManifest; mdlAccount"
                        "horizon.test.unit" "tool-library.test.ts"
                        "horizon.note" "M6：退役须尊重 deps DAG"
                    }
                }

                growthCycle = component "Growth Cycle" "【✅ P1】外循环编排 reEncode→mine→antiUnify→replay→MDL" "TypeScript" {
                    tags "Inner-Module" "Tool-MDL"
                    properties {
                        "path" "packages/server/src/openkuroneko/tool-mdl/growth-cycle.ts"
                        "horizon.intention" "离线、每 N 个任务一次；模型只做反合一+写函数体"
                        "horizon.in" "traces + library + LlmPort + ExecutorPort"
                        "horizon.out" "accepted[] · retired[] · rejected[]"
                        "horizon.deps" "traceMiner; toolReplayGate; mdlAccount; toolLibrary"
                        "horizon.test.integration" "toolMdlGrowth.component.integration.test.ts"
                        "horizon.note" "M4/M11；对照臂 A 内联 create_tool 须可分别开关"
                    }
                }

                baseNodeExecutor = component "BaseNode Executor (DyFlow)" "单 baseNode 执行：LLM + tools allowlist + ReAct（猛猛干）；产出 outputs 或 high-confidence failure_summary" "TypeScript" {
                    tags "Inner-Module" "DyFlow-Phase" "Planned"
                    properties {
                        "path" "packages/server/src/openkuroneko/inner-brain/base-node-executor.ts"
                        "horizon.intention" "DyFlow baseNode：ReAct + fail-fast + §6.7 机械验票"
                        "horizon.in" "LocalNode.body.executor + NodeInst.instruction? + memoryIn"
                        "horizon.out" "node_results[id] status ok|capped|failed + outputs | failure_summary"
                        "horizon.deps" "innerFileTools; shellExec; webSearch; nodeAcceptance; etc."
                        "horizon.test.unit" "base-node-executor.test.ts"
                        "horizon.note" "见 DYFLOW-INNER-EXECUTOR.md §6 §6.7 §6.7a P-prompt（deliverable 注入 user message）"
                    }
                }

                nodeAcceptance = component "Node Acceptance" "baseNode 完成验票：interface.outputs 机械校验 + shell_exec 假成功检测" "TypeScript" {
                    tags "Inner-Module" "DyFlow-Phase"
                    properties {
                        "path" "packages/server/src/openkuroneko/inner-brain/node-acceptance.ts"
                        "horizon.intention" "LLM 停工具后验票；避免 404 shell 与空摘要算 ok"
                        "horizon.deps" "baseNodeExecutor"
                        "horizon.test.unit" "node-acceptance.test.ts"
                        "horizon.note" "DYFLOW-INNER-EXECUTOR.md §6.7"
                    }
                }

                failureDistill = component "Failure Distill" "RUN 失败后蒸馏 last_failure/node_results → memory.constraints（mandatory）" "TypeScript" {
                    tags "Inner-Module" "DyFlow-Phase"
                    properties {
                        "path" "packages/server/src/openkuroneko/inner-brain/failure-distill.ts"
                        "horizon.intention" "对称 §7b 成功梯子；替代 Attributor constraints.md"
                        "horizon.deps" "memoryStore; innerBrainController"
                        "horizon.test.unit" "failure-distill.test.ts"
                        "horizon.note" "DYFLOW-INNER-EXECUTOR.md §7c"
                    }
                }

                // 节点提升已迁出 RUN：原 nodeCreatorExecutor 删除，提升走 designerToolRegistry.promote_local_node（DESIGN 阶段，见 DYFLOW-INNER-EXECUTOR.md §7/§9b）。

                localNodeStore = component "LocalNode Store" ".brain/local_nodes/*.json + index 读写；preset / creator / imported 三 origin" "TypeScript" {
                    tags "Inner-Module" "Inner-State" "DyFlow-State" "Planned"
                    properties {
                        "path" "packages/server/src/openkuroneko/inner-brain/local-node-store.ts"
                        "horizon.intention" "Designer/runner/Creator/Assembler 共用的节点库；burst 全保留"
                        "horizon.in" "commit / read / list / index"
                        "horizon.out" "LocalNode JSON + index.json"
                        "horizon.note" "schema 见 INNER-NODE-LIFECYCLE.md §2"
                    }
                }

                memoryStore = component "Memory Store" ".brain/memory.json：goal / constraints / facts / last_failure / node_results" "TypeScript" {
                    tags "Inner-Module" "Inner-State" "DyFlow-State" "Planned"
                    properties {
                        "path" "packages/server/src/openkuroneko/inner-brain/memory-store.ts"
                        "horizon.intention" "DyFlow 全局 memory；替代 .brain/knowledge.md / constraints.md / execution-context.json"
                        "horizon.in" "patch(key, value) / get(key) / merge"
                        "horizon.out" "memory.json 持久化"
                        "horizon.note" "迁移见 DYFLOW-INNER-EXECUTOR.md §11"
                    }
                }

                designerToolRegistry = component "Designer Tool Registry" "Designer 专用工具集：list_local_nodes / read_local_node / read_memory / read_trace / search_and_instance / commit_local_dag / report_done" "TypeScript" {
                    tags "Inner-Module" "Inner-Tools" "DyFlow-Phase" "Planned"
                    properties {
                        "path" "packages/server/src/openkuroneko/inner-brain/designer-tools/index.ts"
                        "horizon.intention" "DESIGN 阶段工具 allowlist；与 baseNode tools 隔离"
                        "horizon.deps" "localNodeStore; memoryStore; nodeAssembler(P1); nodeDefDrive9Store(P1)"
                        "horizon.test.integration" "designerToolRegistry.component.integration.test.ts"
                        "horizon.note" "工具列表见 DYFLOW-INNER-EXECUTOR.md §9"
                    }
                }

                presetSeeder = component "Preset Seeder" "首次 spawn 注入 preset/* LocalNode（base / extract_facts）" "TypeScript" {
                    tags "Inner-Module" "DyFlow-State"
                    properties {
                        "path" "packages/server/src/openkuroneko/inner-brain/preset-seeder.ts"
                        "horizon.intention" "preset 不参与 export；版本随 worker 包升级；幂等 seed + 版本升级"
                        "horizon.in" "workDir; PRESET_NODES（preset-nodes.ts TS 常量）"
                        "horizon.out" ".brain/local_nodes/preset/*.json"
                        "horizon.test.unit" "preset-seeder.test.ts"
                        "horizon.note" "PRESET_BASE / PRESET_EXTRACT_FACTS；extract_facts 用 record_fact 写 memory.facts；节点提升走 promote_local_node（非 preset）"
                    }
                }

                memoryTools = component "Memory Tools" "record_fact / record_constraint：runner 派发 baseNode 时注入，把发现写回全局 memory（去重）" "TypeScript" {
                    tags "Inner-Module" "DyFlow-Lifecycle"
                    properties {
                        "path" "packages/server/src/openkuroneko/inner-brain/memory-tools.ts"
                        "horizon.intention" "任意 baseNode 都可固化稳定事实/约束；preset/extract_facts 的主力工具"
                        "horizon.in" "memoryStore"
                        "horizon.out" "Tool[]（合并进 allowlist 过滤前的工具集）"
                        "horizon.deps" "memoryStore"
                        "horizon.test.unit" "extract-facts.test.ts（经 runner 验证注入与去重）"
                    }
                }

                nodeAbstractor = component "Node Abstractor" "LocalNode → NodeDef：LLM 推断 placeholder + 校验 sanitized 无残留 + dedupeKey + 写 nodeDefDrive9Store" "TypeScript" {
                    tags "Inner-Module" "DyFlow-Lifecycle" "Planned-P1"
                    properties {
                        "path" "packages/server/src/openkuroneko/inner-brain/node-abstractor.ts"
                        "horizon.intention" "Creator commit 后 fire-and-forget；origin∈{preset,imported} 跳过"
                        "horizon.in" "LocalNode + envSnapshot"
                        "horizon.out" "NodeDef → drive9 /nodes/shared/"
                        "horizon.deps" "nodeDefDrive9Store; llmGateway"
                        "horizon.test.integration" "nodeAbstractor.component.integration.test.ts"
                        "horizon.test.prompt" "node-abstractor.prompt.test.ts"
                        "horizon.note" "schema + 校验见 INNER-NODE-LIFECYCLE.md §5"
                    }
                }

                nodeAssembler = component "Node Assembler" "NodeDef + binding → LocalNode：LLM 推断 binding（envSnapshot+hints）+ 机械替换 placeholder" "TypeScript" {
                    tags "Inner-Module" "DyFlow-Lifecycle" "Planned-P1"
                    properties {
                        "path" "packages/server/src/openkuroneko/inner-brain/node-assembler.ts"
                        "horizon.intention" "search_and_instance 内部循环；origin=imported；失败包容"
                        "horizon.in" "NodeDef + workDir + bindingHints?"
                        "horizon.out" "LocalNode（origin=imported, sourceDef=<id>@<ver>）"
                        "horizon.deps" "localNodeStore; llmGateway"
                        "horizon.test.integration" "nodeAssembler.component.integration.test.ts"
                        "horizon.test.prompt" "node-assembler.prompt.test.ts"
                    }
                }

                // ── 既有内脑底层模块 ──────────────────────────────────────────────────
                brainFs = component "Brain FS" "File-as-State：.brain/* 读写（DyFlow 主用 localNodeStore + memoryStore；brainFs 仅余 tail/通用文件工具供 completionReport / getSkillContent）" "TypeScript" {
                    tags "Inner-Module" "Inner-State"
                    properties {
                        "path" "packages/server/src/openkuroneko/brain/brain-fs.ts"
                        "horizon.test.unit" "parse-milestones.test.ts"
                        "horizon.test.integration" "brainFs.component.integration.test.ts"
                        "horizon.note" "DyFlow 状态走 memory.json / local_nodes；brainFs 保留通用文件读写"
                    }
                }

                archiveStore = component "Archive Store" "会话归档" "TypeScript" {
                    tags "Inner-Module"
                    properties {
                        "path" "packages/server/src/openkuroneko/archive/fs-store.ts"
                        "horizon.test.unit" "fs-store.test.ts"
                        "horizon.test.integration" "archiveStore.component.integration.test.ts"
                    }
                }

                workdirGuard = component "Workdir Guard" "路径 allowlist；peer 只读；`.inbox/` 不可写" "TypeScript" {
                    tags "Inner-Module" "Inner-Tools"
                    properties {
                        "path" "packages/server/src/openkuroneko/tools/definitions/workdir-guard.ts"
                        "horizon.in" "setWorkDirGuard; setPeerWorkspaces(INNER_PEER_*)"
                        "horizon.out" "isPathReadable / isPathWritable"
                        "horizon.note" "见 INNER-WORKSPACE-INBOX.md R5"
                    }
                }

                innerFileTools = component "Inner File Tools" "read_file / search_files / write_file / edit_file；peer：read_peer_file / list_peer_files" "TypeScript" {
                    tags "Inner-Module" "Inner-Tools"
                    properties {
                        "path" "packages/server/src/openkuroneko/tools/definitions/read-file.ts; search-files.ts; peer-file-tools.ts"
                        "horizon.intention" "baseNode 文件 IO；大文件策略见 INNER-FILE-ACCESS.md"
                        "horizon.in" "tool args + workdirGuard"
                        "horizon.out" "text / hits / write ok"
                        "horizon.deps" "workdirGuard; file-search.ts"
                        "horizon.test.unit" "peer-file-tools.test.ts"
                        "horizon.note" "read_file 整文件读 ⏳ offset/limit；优先 search_files + 分页"
                    }
                }

                describeImageTool = component "Describe Image Tool" "describe_image：栅格图 → visionModel 文字摘要" "TypeScript" {
                    tags "Inner-Module" "Inner-Tools"
                    properties {
                        "path" "packages/server/src/openkuroneko/tools/definitions/describe-image.ts"
                        "horizon.intention" "Playwright 截图 / read_file 二进制失败后的识图路径"
                        "horizon.in" "path; optional prompt; workdirGuard"
                        "horizon.out" "text summary + model header"
                        "horizon.deps" "innerLlmStep; workdirGuard"
                        "horizon.test.unit" "describe-image.test.ts"
                        "horizon.note" "见 INNER-VISION-TOOL.md"
                    }
                }

                browserSessionRegistry = component "Browser Session Registry" "进程内 Playwright 会话：open/act/close + node 结束清理" "TypeScript" {
                    tags "Inner-Module" "Inner-Tools"
                    properties {
                        "path" "packages/server/src/openkuroneko/browser/session-registry.ts"
                        "horizon.intention" "增量 UI 自动化；替代 monolithic shell_exec 脚本"
                        "horizon.in" "browser_open/browser_act args + workDir + nodeInstId"
                        "horizon.out" "session_id; act result; auto-close on baseNode exit"
                        "horizon.deps" "playwright; workdirGuard; baseNodeExecutor"
                        "horizon.test.unit" "session-registry.test.ts; browser-tools.test.ts"
                        "horizon.note" "见 BROWSER-SESSION-TOOL.md"
                    }
                }

                browserTools = component "Browser Tools" "browser_open / browser_act / browser_close / browser_list" "TypeScript" {
                    tags "Inner-Module" "Inner-Tools"
                    properties {
                        "path" "packages/server/src/openkuroneko/tools/definitions/browser-tools.ts"
                        "horizon.in" "session_id + action + workdirGuard paths"
                        "horizon.out" "JSON act result; snapshot/screenshot spill to workspace"
                        "horizon.deps" "browserSessionRegistry"
                        "horizon.test.unit" "browser-tools.test.ts"
                    }
                }

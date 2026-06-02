                workerHost = component "Worker Host" "子进程入口、status.json、tick 循环" "TypeScript" {
                    tags "Inner-Module"
                    properties {
                        "path" "packages/server/src/pi-mono/inner-brain-worker.ts"
                        "horizon.in" "INNER_* env"
                        "horizon.out" ".run/inner-worker-status.json; pi-mono output"
                        "horizon.test.integration" "workerHost.component.integration.test.ts"
                    }
                }

                piMonoScheduler = component "Pi-mono Scheduler" "run-tick：驱动 DyFlow Controller.tick" "TypeScript" {
                    tags "Inner-Module"
                    properties {
                        "path" "packages/server/src/pi-mono/run-tick.ts"
                        "horizon.test.integration" "piMonoScheduler.component.integration.test.ts"
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

                runner = component "Runner (DyFlow)" "RUN 阶段：解析 local_dag，按 NodeInst 派发 baseNode / nodeCreator；写 memory.node_results & last_failure" "TypeScript" {
                    tags "Inner-Module" "Inner-Phase" "DyFlow-Phase" "Planned"
                    properties {
                        "path" "packages/server/src/openkuroneko/inner-brain/runner.ts"
                        "horizon.intention" "顺序/依边执行 local_dag；非 LLM 决策；terminal failure 上交 designer"
                        "horizon.in" "local_dag.json + LocalNode 库"
                        "horizon.out" "memory.node_results.<id>; memory.last_failure"
                        "horizon.deps" "baseNodeExecutor; nodeCreatorExecutor; localNodeStore; memoryStore"
                        "horizon.test.integration" "runner.component.integration.test.ts"
                    }
                }

                baseNodeExecutor = component "BaseNode Executor (DyFlow)" "单 baseNode 执行：LLM + tools allowlist + ReAct（猛猛干）；产出 outputs 或 high-confidence failure_summary" "TypeScript" {
                    tags "Inner-Module" "DyFlow-Phase" "Planned"
                    properties {
                        "path" "packages/server/src/openkuroneko/inner-brain/base-node-executor.ts"
                        "horizon.intention" "DyFlow baseNode：原 Executor 整包，无 maxRounds 硬约束（P0 暂不防烧）"
                        "horizon.in" "LocalNode.body.executor + NodeInst.instruction? + memoryIn"
                        "horizon.out" "node_results[id] = ok | failure_summary（high confidence）"
                        "horizon.deps" "innerFileTools; shellExec; webSearch; etc.（per-LocalNode allowlist）"
                        "horizon.test.integration" "baseNodeExecutor.component.integration.test.ts"
                        "horizon.note" "见 DYFLOW-INNER-EXECUTOR.md §6 失败语义"
                    }
                }

                nodeCreatorExecutor = component "NodeCreator Executor (DyFlow)" "newNodeCreator 节点执行：LLM 推断打包/特化边界；commit_local_node + 触发 nodeAbstractor" "TypeScript" {
                    tags "Inner-Module" "DyFlow-Phase" "Planned"
                    properties {
                        "path" "packages/server/src/openkuroneko/inner-brain/node-creator-executor.ts"
                        "horizon.intention" "mode=pack|specialize；窄工具 commit_local_node；失败写 memory.last_pack_error"
                        "horizon.in" "NodeInst.params{mode,target?,hint?,source_node_ids?} + memory + execution trace"
                        "horizon.out" "新 LocalNode（origin=creator）+ Abstractor 触发"
                        "horizon.deps" "localNodeStore; nodeAbstractor(P1)"
                        "horizon.test.integration" "nodeCreatorExecutor.component.integration.test.ts"
                        "horizon.test.prompt" "node-creator.prompt.test.ts"
                    }
                }

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

                memoryStore = component "Memory Store" ".brain/memory.json：global memory（goal/constraints/facts/last_failure/node_results/kpi_progress）" "TypeScript" {
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

                presetSeeder = component "Preset Seeder" "首次 spawn 注入 preset/* LocalNode（base / node_creator / extract_facts）" "TypeScript" {
                    tags "Inner-Module" "DyFlow-State"
                    properties {
                        "path" "packages/server/src/openkuroneko/inner-brain/preset-seeder.ts"
                        "horizon.intention" "preset 不参与 export；版本随 worker 包升级；幂等 seed + 版本升级"
                        "horizon.in" "workDir; PRESET_NODES（preset-nodes.ts TS 常量）"
                        "horizon.out" ".brain/local_nodes/preset/*.json"
                        "horizon.test.unit" "preset-seeder.test.ts"
                        "horizon.note" "PRESET_BASE / PRESET_NODE_CREATOR / PRESET_EXTRACT_FACTS；extract_facts 用 record_fact 写 memory.facts"
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

                archiveStore = component "Archive Store" "会话归档与 KPI/reflexion meta" "TypeScript" {
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

                workerHost = component "Worker Host" "子进程入口、status.json、tick 循环" "TypeScript" {
                    tags "Inner-Module"
                    properties {
                        "path" "packages/server/src/pi-mono/inner-brain-worker.ts"
                        "horizon.in" "INNER_* env"
                        "horizon.out" ".run/inner-worker-status.json; pi-mono output"
                        "horizon.test.integration" "workerHost.component.integration.test.ts"
                    }
                }

                piMonoScheduler = component "Pi-mono Scheduler" "run-tick：驱动 Controller.tick" "TypeScript" {
                    tags "Inner-Module"
                    properties {
                        "path" "packages/server/src/pi-mono/run-tick.ts"
                        "horizon.test.integration" "piMonoScheduler.component.integration.test.ts; run-burst.integration.test.ts"
                    }
                }

                controllerFsm = component "Controller FSM" "mode 切换 DECOMPOSE|EXECUTE|ATTRIBUTE|BLOCKED" "TypeScript" {
                    tags "Inner-Module" "Inner-Scheduler"
                    properties {
                        "path" "packages/server/src/openkuroneko/controller/controller.ts"
                        "horizon.in" "tick()"
                        "horizon.out" "hadWork; mode 转移"
                        "horizon.test.integration" "controllerFsm.component.integration.test.ts; run-burst.integration.test.ts"
                    }
                }

                decomposer = component "Decomposer" "战术拆解 milestones.md（含 KPI trail 检索）" "TypeScript" {
                    tags "Inner-Module" "Inner-Phase"
                    properties {
                        "path" "packages/server/src/openkuroneko/controller/decomposer.ts"
                        "horizon.intention" "DECOMPOSE 阶段：Goal → 里程碑"
                        "horizon.in" "goal, constraints, INNER_KPI_ID → kpiId"
                        "horizon.out" "milestones.md; mode→EXECUTE"
                        "horizon.test.unit" "parse-milestones.test.ts"
                        "horizon.test.integration" "decomposer.component.integration.test.ts"
                        "horizon.test.prompt" "decomposer.prompt.test.ts"
                    }
                }

                executor = component "Executor" "反应执行：里程碑上 LLM+工具多轮" "TypeScript" {
                    tags "Inner-Module" "Inner-Phase"
                    properties {
                        "path" "packages/server/src/openkuroneko/controller/executor.ts"
                        "horizon.intention" "EXECUTE 阶段"
                        "horizon.in" "active milestone"
                        "horizon.out" "execution-context.json; mode→ATTRIBUTE"
                        "horizon.test.unit" "executor.test.ts"
                        "horizon.test.integration" "executor.component.integration.test.ts; run-burst.integration.test.ts"
                    }
                }

                attributor = component "Attributor" "强制归因：K/S/P + CONTROL 决策" "TypeScript" {
                    tags "Inner-Module" "Inner-Phase"
                    properties {
                        "path" "packages/server/src/openkuroneko/controller/attributor.ts"
                        "horizon.intention" "ATTRIBUTE 阶段"
                        "horizon.in" "execution-context"
                        "horizon.out" "CONTINUE|SUCCESS|REPLAN|BLOCK; .brain 写入"
                        "horizon.test.unit" "attributor-parse.test.ts"
                        "horizon.test.integration" "attributor.component.integration.test.ts"
                        "horizon.test.prompt" "attributor.prompt.test.ts"
                    }
                }

                reflexionModule = component "Reflexion" "safeArchive 内 runReflexion → reflexion.json + archive meta" "TypeScript" {
                    tags "Inner-Module" "Inner-Phase"
                    properties {
                        "path" "packages/server/src/openkuroneko/controller/reflexion.ts"
                        "horizon.intention" "跨 burst 反思，供 onExit hook 与下轮 decomposer"
                        "horizon.in" "burst 上下文、trigger、kpiId"
                        "horizon.out" ".brain/reflexion.json; archive session"
                        "horizon.deps" "llmGateway"
                        "horizon.test.integration" "reflexionModule.component.integration.test.ts"
                        "horizon.test.prompt" "reflexion.prompt.test.ts"
                    }
                }

                blockResolver = component "Block Resolver" "BLOCKED 解封与 directive 消费" "TypeScript" {
                    tags "Inner-Module"
                    properties {
                        "path" "packages/server/src/openkuroneko/controller/block-resolver.ts"
                        "horizon.test.integration" "blockResolver.component.integration.test.ts"
                    }
                }

                brainFs = component "Brain FS" "File-as-State：.brain/* 读写" "TypeScript" {
                    tags "Inner-Module" "Inner-State"
                    properties {
                        "path" "packages/server/src/openkuroneko/brain/brain-fs.ts"
                        "horizon.test.unit" "parse-milestones.test.ts"
                        "horizon.test.integration" "brainFs.component.integration.test.ts"
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

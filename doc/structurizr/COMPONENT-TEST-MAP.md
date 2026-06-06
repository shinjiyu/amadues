# Structurizr L3 组件 ↔ 测试用例对照表

> **原则**：每个 ADL `component` 一行；测试按 [`COMPONENT-TESTING.md`](./COMPONENT-TESTING.md) 命名（`*.component.integration.test.ts` 等）。  
> 汇总统计仍见 [`doc/testing-strategy.md`](../testing-strategy.md) §4。

## 设计原则（与 ADL 一致）

| 层级 | 测什么 | 文件后缀 |
|------|--------|----------|
| **单元** | 纯函数 / 解析 / 策略（`horizon.in` 的可测子集） | `*.test.ts` |
| **模块（黑盒）** | 单一职责的 In→Out 契约，临时 workDir / FakeLLM | `*.component.integration.test.ts` |
| **Prompt 效果** | 真实 LLM + prompt 输出形态 | `*.prompt.test.ts` |
| **装配** | `index` 启停、假入站→假出站 | 最后做（§4.4） |

红线见 testing-strategy §8：单测不跨模块 import；**不以 Structurizr 组件名为文件名**，而以**可测入口函数**命名（组件测文件例外：`*.<moduleId>.component.integration.test.ts`）。

## 外脑 L3（`agentServer`）

| ADL 模块 ID | 单元测 | 模块测 | Prompt 测 | 备注 |
|-------------|--------|--------|-----------|------|
| participationPolicy | ✅ `inbound-policy.test.ts` | ✅ `participationPolicy.component.integration.test.ts` | ✅ `inbound-policy.prompt.test.ts` | 样板组件 |
| outerBrainFacade | 🟡 片段 | ✅ `outerBrainFacade.component.integration.test.ts` | — | + `integration/outer-brain-inbound` 全链 |
| knowledgeRetrieval | ❌ | ✅ `knowledgeRetrieval.component.integration.test.ts` | — | |
| threadOrchestrator | ✅ `chat-ir/seen-tracker.test.ts`（freshCheck @ 语义） | ✅ `threadOrchestrator.component.integration.test.ts`（串行 + FIFO 排队） | — | freshCheck 实现于 `@utlra/chat-ir` |
| outerConversationLoop | ❌ | ✅ `outerConversationLoop.component.integration.test.ts` | — | + `integration/outer-conversation-loop-assembly` |
| outerToolExecutor | 🟡 tools 单测散落 | ✅ `outerToolExecutor.component.integration.test.ts` | — | `normalizeAgentReplyMentionText` |
| **workspaceInbox** | ✅ `workspace-inbox.test.ts` | ⏳ | — | ADL [`INNER-WORKSPACE-INBOX.md`](./INNER-WORKSPACE-INBOX.md) |
| **innerFileTools** | ✅ `read-file-lines.test.ts` | — | — | ADL [`INNER-FILE-ACCESS.md`](./INNER-FILE-ACCESS.md) |
| **describeImageTool** | ✅ `describe-image.test.ts` | — | — | ADL [`INNER-VISION-TOOL.md`](./INNER-VISION-TOOL.md) |
| **shellProbe** | ✅ `shell-probe.test.ts` | — | — | ADL [`DYFLOW-INNER-EXECUTOR.md`](./DYFLOW-INNER-EXECUTOR.md) §6.6 |
| **reactToolCallSlim** | ✅ `react-tool-call-slim.test.ts` | — | — | ADL §6.5 P2.5 |
| outerOrchestrator | 🟡 parse | ✅ `outerOrchestrator.component.integration.test.ts` | — | + `outer-roundtrip` / `outer-roundtrip-inner`（注入 spawn） |
| innerBrainKpiReuse | ✅ `inner-brain-kpi-reuse.test.ts` | ⏳ | — | ADL [`INNER-BRAIN-SINGLE-INSTANCE.md`](./INNER-BRAIN-SINGLE-INSTANCE.md) |
| innerBrainRegistry | ❌ | ✅ `innerBrainRegistry.component.integration.test.ts` | — | |
| innerSpawner | ❌ | ✅ `innerSpawner.component.integration.test.ts` | — | + 可选 `spawn-inner-worker-live`（`UTLRA_TEST_SPAWN_INNER=1`） |
| kpiRegistry | 🟡 `kpi-registry.test.ts` | ✅ `kpiRegistry.component.integration.test.ts` | — | |
| kpiBurstHooks | ✅ `kpi-burst-hooks.test.ts` | ✅ `kpiBurstHooks.component.integration.test.ts` | — | 与 `kpi-lifecycle.integration` 互补 |
| kpiCompletionJudge | ✅ `kpi-completion-judge.test.ts` | — | — | ADL [`KPI-COMPLETION-JUDGE.md`](./KPI-COMPLETION-JUDGE.md) |
| outerHeartbeat | 🟡 death-detect | ✅ `outer-heartbeat.integration.test.ts` + `autonomy-heartbeat.component.integration.test.ts` | — | ADL [`OUTER-HEARTBEAT-OVERSIGHT.md`](./OUTER-HEARTBEAT-OVERSIGHT.md) |
| outerMemory | ✅ `memory-belief-reconcile.test.ts` | ✅ `outerMemory.component.integration.test.ts` | — | Belief MVP |
| completionNotify | 🟡 `completion-notify.test.ts` + `completion-report.test.ts` (im/verbose) | ✅ `completionNotify.component.integration.test.ts` | — | R6.4 + `completion-notified.json` dedup |
| imNotifyDedup | ✅ `im-notify-dedup.test.ts` | — | — | ADL [`INNER-BRAIN-IM-NOTIFY-BOUNDARY.md`](./INNER-BRAIN-IM-NOTIFY-BOUNDARY.md) §2 |
| awaitingNotify | ✅ `awaiting-notify.test.ts` | — | — | onExit AWAITING + ask_user |
| pushLoop | ✅ `push-loop.test.ts` | ✅ `pushLoop.component.integration.test.ts` | — | BLOCK **不**推 IM；PROGRESS 可选 |
| changeWatcher | ✅ `change-watcher.test.ts` + `change-watcher.bootstrap.test.ts` | ✅ `changeWatcher.component.integration.test.ts` | — | spawn 前 markConsumed |
| brainAsyncSnapshot | ✅ `brain-async-snapshot.test.ts` | — | — | |
| registryLifecycleReconcile | ✅ `registry-lifecycle-reconcile.test.ts` | ✅ `registryLifecycleReconcile.component.integration.test.ts` | — | 含周期 reconcile |
| awaitingInboundResolver | ✅ `awaiting-inbound-resolver.test.ts` | ✅ `awaitingInboundResolver.component.integration.test.ts` | — | IM→resolve；B2 凭证→credential_ref |
| memoryBlockStore | ✅ `memory-block-store.test.ts` + `memory-block-tools.test.ts` | ✅ `memoryBlockStore.component.integration.test.ts` | — | B1 工具已接 outerToolExecutor |
| innerBrainStartupResume | ✅ `inner-brain-startup-resume.test.ts` | ✅ `innerBrainStartupResume.component.integration.test.ts` | — | ADL [`INNER-BRAIN-RESUME.md`](./INNER-BRAIN-RESUME.md) |
| llmGateway | ✅ `raw.test.ts` 等 | ✅ `llmGateway.component.integration.test.ts` | — | |
| llmUsageTracker | ✅ `llm-usage-tracker.test.ts` | — | — | 内存滚动窗口 |
| llmUsageJournal | ✅ `llm-usage-journal.test.ts` | ✅ `llmUsageJournal.component.integration.test.ts` | — | ADL [`LLM-USAGE-JOURNAL.md`](./LLM-USAGE-JOURNAL.md) |
| environmentSensorRegistry | ⏳ `environment-sensor-registry.test.ts` | ⏳ `environmentSensorRegistry.component.integration.test.ts` | — | ADL [`ENVIRONMENT-MODEL.md`](./ENVIRONMENT-MODEL.md) |
| environmentJournal | ⏳ `environment-journal.test.ts` | ⏳ `environmentJournal.component.integration.test.ts` | — | rotation + 未消费查询 |
| environmentChangeDetector | ⏳ `environment-change-detector.test.ts` | — | — | hysteresis / warmUp / derive |
| strategyStore | ⏳ `strategy-store.test.ts` | — | — | ADL [`STRATEGY-PLANNING-LAYER.md`](./STRATEGY-PLANNING-LAYER.md) |
| strategyPlanner | — | ⏳ `strategyPlanner.component.integration.test.ts` | ⏳ `strategy-planner.prompt.test.ts` | FakeLLM → typed artifact |
| staleBurstReaper | ⏳ `stale-burst-reaper.test.ts` | ⏳ `staleBurstReaper.component.integration.test.ts` | — | peek + SIGTERM/KILL + ABORTED + archive |
| **frameworkBenchmarkHarness** | ✅ `token-estimate.test.ts` | ✅ `framework-benchmark.component.integration.test.ts` | — | ADL [`FRAMEWORK-BENCHMARK.md`](./FRAMEWORK-BENCHMARK.md) · S1/S2 + `baseline.json` |
| **nodeDefDrive9Store** | ✅ `node-def-drive9-store.test.ts`（put/get/index/dedupe/search/tombstone） | — | — | ADL [`INNER-NODE-LIFECYCLE.md`](./INNER-NODE-LIFECYCLE.md) §5.4（P1，注入 Drive9Fs） |
| **nodeDefEviction** | ✅ `node-def-eviction.test.ts`（score + cold + quota） | — | — | dedupe + quota + cold tombstone（P2） |

## 元宝 PSTune（`data-yuanbao` workspace · ADL [`BATTLE-TUNE-LOOP.md`](./BATTLE-TUNE-LOOP.md)）

| 模块 ID | 单元测 | 模块测 | 备注 |
|---------|--------|--------|------|
| profileLoader | ✅ `profile_loader.test.mjs` | ⏳ | `tuning/profile_loader.mjs` |
| battleAnalyzer | ⏳ | ⏳ | `tuning/battle_analyzer.mjs` |
| replayInjector | — | ⏳ | 离线 replay JSON → override diff |
| pstuneCli | — | ⏳ | `pstune.mjs analyze` / `gate` |

路径根：`packages/server/data-yuanbao/workspaces/task-ib-mpvf5dh8-6070/`

## 内脑 L3（`innerWorker`）

> **DyFlow 单引擎**：旧三件套 `decomposer / executor / attributor / blockResolver` 及 `reflexion` 已删除（含全部对应测试）。详见 [`DYFLOW-INNER-EXECUTOR.md`](./DYFLOW-INNER-EXECUTOR.md)、[`INNER-NODE-LIFECYCLE.md`](./INNER-NODE-LIFECYCLE.md)。

| ADL 模块 ID | 单元测 | 模块测 | Prompt 测 | 备注 |
|-------------|--------|--------|-----------|------|
| workerHost | ❌ | ✅ `workerHost.component.integration.test.ts` | — | status.json 契约 |
| piMonoScheduler | ❌ | ✅ `piMonoScheduler.component.integration.test.ts` | — | stop 信号 + runtime 标签 |
| controllerFsm | — | ✅ `controllerFsm.component.integration.test.ts` | — | DyFlow DESIGN/RUN/AWAITING/DONE |
| completionReport | ✅ `completion-report.test.ts`（im/verbose） | — | — | burst DONE 完成报告正文 |
| **designer** | ✅ `designer.test.ts`（run/done/empty + ref 校验） | ✅ `controller.component.integration.test.ts`（DESIGN↔RUN↔DONE 全链） | ⏳ `designer.prompt.test.ts` | P0；DESIGN ↔ RUN 切换 + last_failure 决策表 |
| **runner** | ✅ `runner.test.ts`（顺序图 + terminal stop + 缺 ref + compound 展开） | ✅ `controller.component.integration.test.ts` | — | P0；顺序图 + dispatch + memory 写入 |
| **baseNodeExecutor** | ✅ `base-node-executor.test.ts`（render/terminal/allowlist/fail-fast + acceptance + shell-evidence + runtime） | — | — | P0；ReAct + §6.7 验票 |
| **nodeAcceptance** | ✅ `node-acceptance.test.ts`（json/file/string + shell 404 + deliverable AND） | — | — | P0b；DYFLOW §6.7 / §6.7a |
| **deliverableCheck** | ✅ `deliverable-check.test.ts`（file/json_key/stdout_contains/stdout_absent） | — | — | DYFLOW §6.7a；report_done 闸门 §9a |
| **failureDistill** | ✅ `failure-distill.test.ts`（distill + dedupe append） | — | — | P0b；DYFLOW §7c |
| **runtimeContext** | ✅ `runtime-context.test.ts`（platform/shell/vault/env_keys） | — | — | P0；baseNode system 常驻环境块 |
| **innerKeychainTools** | ✅ `keychain-tools.test.ts`（entries/get + 无 dataRoot） | — | — | P0；内脑 vault 只读 |
| **reactMessagePrune** | ✅ `react-message-prune.test.ts` | — | — | P2；旧轮 tool prune |
| **toolOutputSpill** | ✅ `tool-output-spill.test.ts` | — | — | P2；超大 tool 落盘 |
| **shellStallGuard** | ✅ `shell-stall-guard.test.ts` | — | — | P2；重复 shell 失败 |
| **burstStallEvaluator** | ✅ `burst-stall-evaluator.test.ts` | — | — | P0 观测；空转信号 |
| **burstStallAlert** | ✅ `burst-stall-alert.test.ts` | — | — | P0 观测；落盘 + debounce |
| **localNodeStore** | ✅ `local-node-store.test.ts`（schema/嵌套 id/穿越/index 重建） | — | — | P0；schema 校验 + index |
| **memoryStore** | ✅ `memory-store.test.ts`（点路径/last_failure/node_results/facts/dag_history 环形/locked_milestones 去重） | — | — | P0；last_failure / node_results / facts / dag_history / locked_milestones |
| **designerToolRegistry** | ✅ `search-and-instance.test.ts`（装配失败包容 + 幂等） | ✅ `designer.test.ts`（list/read/commit/report verify 闸门/promote/lock_milestone+拦截） | — | P0；list/read/commit/report+verify/promote/lock |
| **presetSeeder** | ✅ `preset-seeder.test.ts`（首次 seed/跳过/版本升级/export=false） | — | — | P0；首次 seed + 已存在跳过 |
| **nodeAbstractor** | ✅ `node-abstractor.test.ts`（sanitize 残留/origin 过滤/dedupe） | — | ⏳ `node-abstractor.prompt.test.ts` | P1；origin 过滤 + dedupeKey |
| **nodeAssembler** | ✅ `node-assembler.test.ts`（applyBinding 无残留/幂等/缺 required） | — | ⏳ `node-assembler.prompt.test.ts` | P1；binding 推断 + 失败包容 |
| brainFs | ✅ `parse-milestones.test.ts` | ✅ `brainFs.component.integration.test.ts` | — | DyFlow 后仅余通用文件读写（tail 等） |
| archiveStore | ✅ `fs-store.test.ts` | ✅ `archiveStore.component.integration.test.ts` | — | |

## 实施阶段（testing-strategy §7）

| 阶段 | 状态 | 与「每组件测试」关系 |
|------|------|---------------------|
| A 设计 | ✅ | §4 矩阵 + 本文 |
| B testing kit | ✅ | fake-llm / fixture / temp-data-root |
| C 可注入重构 | ✅ | policy / controller / heartbeat / loop |
| D 单元 | ✅ 大部分 | 与组件测互补 |
| D' Prompt | ✅ DyFlow + participation | `designer` / `node-creator` / `node-abstractor` `.prompt.test.ts` |
| **E 模块黑盒** | **✅ L3 全覆盖** | 27 组件 + 既有 `integration/*` |
| F 装配 | ✅ | 上列 + `index-listen-smoke`（子进程 listen）/ `index-app-health` |
| E.1 编排 | ✅ | `await-and-wake` / `inbound-policy-table` / `outer-heartbeat` |

## 运行

```bash
npm run test:integration -w @utlra/server   # 70+ 项（含 index-listen 子进程烟测；live spawn 默认 skip）
npm run test:prompt -w @utlra/server        # 11 项（真实 LLM，缺 key 则 fail）
npm run test:unit -w @utlra/server
```

## 下一步

1. **CI nightly**（可选）`UTLRA_TEST_SPAWN_INNER=1` 跑真实内脑子进程
2. **index** 子进程内再测 `POST /api/outer/roundtrip`（HTTP 契约，当前由模块测覆盖）

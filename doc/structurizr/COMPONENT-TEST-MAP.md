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
| outerOrchestrator | 🟡 parse | ✅ `outerOrchestrator.component.integration.test.ts` | — | + `outer-roundtrip` / `outer-roundtrip-inner`（注入 spawn） |
| innerBrainRegistry | ❌ | ✅ `innerBrainRegistry.component.integration.test.ts` | — | |
| innerSpawner | ❌ | ✅ `innerSpawner.component.integration.test.ts` | — | + 可选 `spawn-inner-worker-live`（`UTLRA_TEST_SPAWN_INNER=1`） |
| kpiRegistry | 🟡 `kpi-registry.test.ts` | ✅ `kpiRegistry.component.integration.test.ts` | — | |
| kpiBurstHooks | ✅ `kpi-burst-hooks.test.ts` | ✅ `kpiBurstHooks.component.integration.test.ts` | — | 与 `kpi-lifecycle.integration` 互补 |
| outerMemory | ✅ `memory-belief-reconcile.test.ts` | ✅ `outerMemory.component.integration.test.ts` | — | Belief MVP |
| completionNotify | 🟡 `completion-notify.test.ts` + `completion-report.test.ts` (im/verbose) | ✅ `completionNotify.component.integration.test.ts` | — | R6.4 `inner-brain-deliverables.md` |
| pushLoop | ❌ | ✅ `pushLoop.component.integration.test.ts` | — | BLOCK → IM |
| changeWatcher | ✅ `change-watcher.test.ts` + `change-watcher.bootstrap.test.ts` | ✅ `changeWatcher.component.integration.test.ts` | — | bootstrap + reconcile 已接 |
| brainAsyncSnapshot | ✅ `brain-async-snapshot.test.ts` | — | — | |
| registryLifecycleReconcile | ✅ `registry-lifecycle-reconcile.test.ts` | ✅ `registryLifecycleReconcile.component.integration.test.ts` | — | 含周期 reconcile |
| awaitingInboundResolver | ✅ `awaiting-inbound-resolver.test.ts` | ✅ `awaitingInboundResolver.component.integration.test.ts` | — | IM→resolve；B2 凭证→credential_ref |
| memoryBlockStore | ✅ `memory-block-store.test.ts` + `memory-block-tools.test.ts` | ✅ `memoryBlockStore.component.integration.test.ts` | — | B1 工具已接 outerToolExecutor |
| innerBrainStartupResume | ✅ `inner-brain-startup-resume.test.ts` | ✅ `innerBrainStartupResume.component.integration.test.ts` | — | ADL [`INNER-BRAIN-RESUME.md`](./INNER-BRAIN-RESUME.md) |
| llmGateway | ✅ `raw.test.ts` 等 | ✅ `llmGateway.component.integration.test.ts` | — | |
| llmUsageTracker | ✅ `llm-usage-tracker.test.ts` | — | — | 内存滚动窗口 |
| llmUsageJournal | ✅ `llm-usage-journal.test.ts` | ✅ `llmUsageJournal.component.integration.test.ts` | — | ADL [`LLM-USAGE-JOURNAL.md`](./LLM-USAGE-JOURNAL.md) |

## 内脑 L3（`innerWorker`）

| ADL 模块 ID | 单元测 | 模块测 | Prompt 测 | 备注 |
|-------------|--------|--------|-----------|------|
| workerHost | ❌ | ✅ `workerHost.component.integration.test.ts` | — | status.json 契约 |
| piMonoScheduler | ❌ | ✅ `piMonoScheduler.component.integration.test.ts` | — | stop 信号 + runtime 标签 |
| controllerFsm | 🟡 completion-report | ✅ `controllerFsm.component.integration.test.ts` | ❌ E.1 run-burst | BrainFS state |
| decomposer | ✅ `parse-milestones.test.ts` | ✅ `decomposer.component.integration.test.ts` | ✅ `decomposer.prompt.test.ts` | |
| executor | 🟡 | ✅ `executor.component.integration.test.ts` | — | + `executor-resolved-pendings.test.ts` |
| attributor | ✅ `attributor-parse.test.ts` + `research-skill-policy.test.ts` | ✅ `attributor.component.integration.test.ts` | ✅ `attributor.prompt.test.ts` | R1 研究里程碑 write_skill 门控 |
| reflexionModule | ✅ reflexion 解析 | ✅ `reflexionModule.component.integration.test.ts` | ✅ `reflexion.prompt.test.ts` | |
| blockResolver | ❌ | ✅ `blockResolver.component.integration.test.ts` | — | FakeLLM |
| brainFs | ✅ `parse-milestones.test.ts` | ✅ `brainFs.component.integration.test.ts` | — | |
| archiveStore | ✅ `fs-store.test.ts` | ✅ `archiveStore.component.integration.test.ts` | — | |

## 实施阶段（testing-strategy §7）

| 阶段 | 状态 | 与「每组件测试」关系 |
|------|------|---------------------|
| A 设计 | ✅ | §4 矩阵 + 本文 |
| B testing kit | ✅ | fake-llm / fixture / temp-data-root |
| C 可注入重构 | ✅ | policy / controller / heartbeat / loop |
| D 单元 | ✅ 大部分 | 与组件测互补 |
| D' Prompt | ✅ 内脑三件套 + participation | `attributor` / `decomposer` / `reflexion` `.prompt.test.ts` |
| **E 模块黑盒** | **✅ L3 全覆盖** | 27 组件 + 既有 `integration/*` |
| F 装配 | ✅ | 上列 + `index-listen-smoke`（子进程 listen）/ `index-app-health` |
| E.1 编排 | ✅ | `run-burst` / `await-and-wake` / `inbound-policy-table` / `outer-heartbeat` |

## 运行

```bash
npm run test:integration -w @utlra/server   # 70+ 项（含 index-listen 子进程烟测；live spawn 默认 skip）
npm run test:prompt -w @utlra/server        # 11 项（真实 LLM，缺 key 则 fail）
npm run test:unit -w @utlra/server
```

## 下一步

1. **CI nightly**（可选）`UTLRA_TEST_SPAWN_INNER=1` 跑真实内脑子进程
2. **index** 子进程内再测 `POST /api/outer/roundtrip`（HTTP 契约，当前由模块测覆盖）

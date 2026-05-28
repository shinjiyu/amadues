# 模块视界目录（细粒度 · 与 workspace.dsl 同步）

> 对齐规则见 [`GRANULARITY.md`](./GRANULARITY.md)。**一模块 = 一事 + 可写清 In/Out**。

---

## L2 容器（进程 / 包）

见 `workspace.dsl` 中 `chatIrLib`、`agentServer`、`innerWorker` 等容器级 `horizon.*`。

**L1 约定（系统上下文）**：

- **用户**只经 **IM 接口**（`discord`、`localWebChatIm`）使用系统，**不**直连 `kuroneko` Agent API。
- **本地 IM** 在 L1 为 `localWebChatIm`，L2 由 `chatServer` + `webChat` 实现。
- **内外脑监控** 在 L1 为 `brainMonitoring`，L2 由 `opsConsole` + `performanceDashboard` 实现；**运维/观察者** 与终端用户分离。

---

## L3 — 外脑模块（`agentServer` 进程）

| 模块 ID | 职责 | 主路径 | In → Out |
|---------|------|--------|----------|
| **participationPolicy** | **是否说话 / 是否回复** | `outer/inbound-policy.ts` + `participation-state.ts` | `OuterInboundMeta` → `shouldReply` / SPEAK·SILENT |
| outerBrainFacade | 外脑编排入口 | `outer/outer-brain.ts` | `ChatIRInboundEvent` → 调 loop / policy |
| knowledgeRetrieval | 知识检索 | `outer/knowledge-retrieval.ts` | query → K/S/P 片段 |
| threadOrchestrator | 线程串行 + mention 感知 freshCheck + FIFO 排队 | `outer/thread-orchestrator.ts`; `chat-ir/seen-tracker.ts` | thread ops |
| outerConversationLoop | 外脑多轮 LLM | `outer/outer-conversation-loop.ts` | context → tool_calls |
| outerToolExecutor | 外脑工具执行 | `outer/outer-tools.ts` | tool_call → reply/spawn |
| outerOrchestrator | M6 roundtrip | `outer/orchestrator.ts` | 入站 → reply + spawn |
| innerBrainRegistry | 内脑任务表 | `outer/inner-brain-registry.ts` | spawn/stop → TaskRecord；`markStaleRunningAsStopped` |
| innerBrainStartupResume | **外脑重启恢复 RUNNING** | `outer/inner-brain-startup-resume.ts` | 启动 → 同一 instance 再 spawn |
| brainAsyncSnapshot | workDir 异步快照 | `outer/brain-async-snapshot.ts` | workDir → `is_post_complete` 等 |
| registryLifecycleReconcile | **registry↔workDir 对账** | `outer/registry-lifecycle-reconcile.ts` | 假 AWAITING → DONE |
| awaitingInboundResolver | **IM 回复解 pending** | `outer/awaiting-inbound-resolver.ts` | human IM → resolve → changeWatcher spawn |
| innerSpawner | spawn 子进程 | `pi-mono/inner-brain-spawner.ts` | goal/workDir → child |
| kpiRegistry | KPI 与反思 burst | `outer/kpi-registry.ts` | set_kpi → trail / idleStreak |
| kpiBurstHooks | burst 退出 hook | `outer/kpi-burst-hooks.ts` | reflexion.json → trail；streak → meta；AUTO_NEXT → 下一 burst |
| outerMemory | mem9 记忆 | `outer/outer-memory.ts` | chat/task → mem9 |
| **memoryBlockStore** | **结构化 Block CRUD** | `outer/memory-block-store.ts` + `memory-block-tools.ts` | `memory_block_*`；bind → `.brain/secrets/` |
| completionNotify | 完成通知（IM 精简） | `outer/completion-notify.ts` + `completion-report.ts` | DONE → `audience=im` 正文 + 附件 |
| pushLoop | 消费 worker 输出 | `outer/push-loop.ts` | `.run` events → 渠道 |
| changeWatcher | AWAITING 唤醒 | `pi-mono/change-watcher.ts` | bootstrap + pendings 到期/解封 → spawn |
| llmGateway | LLM 调用 | `llm/` | messages → text/tools |

**视图**（Structurizr，按路径拆开避免一张图过密）：

| 视图 | 内容 |
|------|------|
| `06-L3-Outer-AllModules` | 全部外脑组件 + 所有 L3 边 |
| `07-L3-Outer-Inbound-IM` | IM 入站：Facade → **awaitingInboundResolver** → 检索/记忆/是否说话 → 对话环 → 工具 |
| `07b-L3-Outer-Inbound-HTTP` | HTTP roundtrip：Orchestrator → policy → 直 spawn |
| `08-L3-Outer-Inner-Lifecycle` | spawn、**startupResume**、**reconcile**、registry、changeWatcher、pushLoop、completionNotify、KPI |
| `10-L2-KPI-Closed-Loop` | L2：agentServer ↔ innerWorker |
| `10b-L3-Outer-KPI` / `10c-L3-Inner-Reflexion` | L3 外脑调度 / 内脑反思分图 |

**KPI 闭环**（实现与 ADL）：见 [`KPI-CLOSED-LOOP.md`](./KPI-CLOSED-LOOP.md)。

**外脑重启恢复内脑**（实现与 ADL）：见 [`INNER-BRAIN-RESUME.md`](./INNER-BRAIN-RESUME.md)。

**AWAITING 生命周期**：[`INNER-BRAIN-AWAITING-LIFECYCLE.md`](./INNER-BRAIN-AWAITING-LIFECYCLE.md)。  
**Memory Block**：[`MEMORY-BLOCKS.md`](./MEMORY-BLOCKS.md)。

**记忆/知识边界**（P3c）：见 [`MEMORY-STORAGE-BOUNDARY.md`](./MEMORY-STORAGE-BOUNDARY.md)。

**测试**（按 component）：[`COMPONENT-TESTING.md`](./COMPONENT-TESTING.md) · 清单 [`COMPONENT-TEST-MAP.md`](./COMPONENT-TEST-MAP.md)

**双入口**：生产 IM 走 `outerBrainFacade`；`POST /api/outer/roundtrip` 走 `outerOrchestrator`（spawn 可不经过 registry）。

---

## L3 — 内脑模块（`innerWorker` 子进程）

| 模块 ID | 职责 | 主路径 | In → Out |
|---------|------|--------|----------|
| workerHost | 子进程入口 | `pi-mono/inner-brain-worker.ts` | env → status.json |
| piMonoScheduler | tick 驱动 | `pi-mono/run-tick.ts` | — → `Controller.tick` |
| controllerFsm | **阶段状态机** | `openkuroneko/controller/controller.ts` | tick → mode 切换 |
| **decomposer** | **DECOMPOSE 阶段** | `controller/decomposer.ts` | goal → milestones.md |
| **executor** | **EXECUTE 阶段** | `controller/executor.ts` | milestone → execution-context |
| **attributor** | **ATTRIBUTE 阶段** | `controller/attributor.ts` | context → CONTROL 决策 + .brain |
| **reflexionModule** | **反思模块** | `controller/reflexion.ts` | safeArchive → reflexion.json + archive(kpiId) |
| blockResolver | BLOCKED 解封 | `controller/block-resolver.ts` | directives → 解封 |
| brainFs | File-as-State | `brain/brain-fs.ts` | 读写 `.brain/*` |
| archiveStore | 归档 | `archive/fs-store.ts` | archive → session |

**视图**：`09-L3-Inner-Phases`（三阶段 + reflexion + controller + blockResolver）。

阶段循环（与代码一致）：

```text
DECOMPOSE → EXECUTE → ATTRIBUTE → (CONTINUE|下一里程碑|REPLAN|BLOCK)
                ↑________________________|
```

---

## L2 共享库

| 库 | path |
|----|------|
| chatIrLib | `packages/chat-ir` |
| **workspaceKit** | `packages/server/src/workspace-kit` — **外脑专用**（P3a 内联，原 `@utlra/core`）。内脑经 **file** 共享 `workDir`，不 import |
| webchatProtocolLib | `packages/webchat-protocol` |
| webchatBridge | `packages/webchat-bridge` — 出站 `asset:` → chat-server `/uploads` |

---

## 修订

| 日期 | 说明 |
|------|------|
| 2026-05-19 | 细粒度：participationPolicy + 内脑三阶段 + reflexion |
| 2026-05-19 | KPI 闭环接通：视图 `10-L2` / `10b` / `10c` + `KPI-CLOSED-LOOP.md` |
| 2026-05-20 | P2：`deps.rules.cjs` + `npm run structurizr:deps` |
| 2026-05-20 | P3c：`MEMORY-STORAGE-BOUNDARY.md` + repository/mem9/drive9 deps 规则 |

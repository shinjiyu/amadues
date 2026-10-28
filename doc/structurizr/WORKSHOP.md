# 车间（ADL 权威）

> **English:** Executable tasks enter a shared workshop. Each task is a new worker at an empty bench. Abstract work is split by the outer brain before entry. A worker who must wait stays at the bench. A separate timer only dispatches a worker when time is due. OKR, KPI, and idle work-finding are marked for deletion.
>
> **状态**：2026-10-17 实现中。派活改为两路：外脑 `set_goal` 派工人，定时管理器到点再派一名工人。工人在台上等待，上班时读一次各台日志，交付只登记、不发固定句。KPI、闲时找活、离台再唤醒已从启动和工具里拆掉。车间余量第一笔记的是浏览器实例：每轮读给工人，打开时领取或拒绝，不拿余量决定能否派工。本文是派活权威，取代 [`DIGITAL-EMPLOYEE-AUTONOMY.md`](./DIGITAL-EMPLOYEE-AUTONOMY.md)、[`KPI-MANAGER-LAYER.md`](./KPI-MANAGER-LAYER.md) 和闲时找活。那些专篇文首已标待删除或改写，正文留下对照，**不要再按那些正文实现**。

---

## 1. 名词

| 词 | 含义 |
|----|------|
| **车间** | 共享的工作环境。浏览器、登录会话这一类资源记在车间，不钉在某一张台。 |
| **工作台** | 一名工人独占来写的 workspace。一个车间里有多张台。每张台有一份工作日志。 |
| **工人** | 一次可执行任务的执行。新任务是一名新工人，坐一张空台。 |
| **工作日志** | 这张台上做过什么、交付落在哪。新工人上班时把所有台的日志读一遍。 |
| **余量** | 车间资源还剩多少。每个决策轮重新输入，当场更新。 |
| **可执行任务** | 目标、完成条件和下一步已经具体，读完日志就能开工。 |
| **定时管理器** | 只做一件事：到点派一名新工人。 |

对外说话不使用内脑、外脑、KPI、burst、`set_goal` 这些词，也没有必说的替换句。

---

## 2. 什么能进车间

进车间的是一名工人能直接上手的任务。抽象目标的细化和拆分在外脑做完，再派进去。外脑不必预先点名会碰到哪些文件。

活只有两个来源：

1. 外脑把用户的话拆成可执行任务，派一名新工人。
2. 定时管理器到点，派一名新工人。

没有第三条。空闲时不围绕长期目标自己找活，也不再记一份 OKR / KPI 账。用户要的重复事情，写成定时管理器里的一条到点派工。

工人干到一半发现这件事还要拆成几件独立的事，把这个发现交回外脑。外脑再拆、再派。这不是台上等待。

---

## 3. 上班

每一件新任务都是一名新工人、一张空台。不回到原来的台。

上班时做一次：只读查阅所有工作台的日志，然后只在自己的台上写。前一台的文件留在原处。最新一台的产出是当前版本。日志里写明仍有人在写的，新工人避开那件工作。

登录和浏览器会话属于车间。新工人不为一份会话回到旧台。

---

## 4. 资源余量

工人自己看余量，自己安排这一轮怎么干。车间记账，在工人实际领取时准许或拒绝。余量不是一道事先决定谁能进车间的门。

工作日志只在上班时读一次。余量每个决策轮都输入，并随领取、释放、被别人领走而更新。

第一笔资源是浏览器实例。账本在 `UTLRA_DATA_ROOT/workshop/resource-ledger.json`，容量由 `WORKSHOP_BROWSER_CAPACITY` 决定，默认 4。Designer、baseNode、Attributor 的每一轮都读当前余量。`browser_open` 成功占一个名额之前先领取；名额没有了就拒绝，不启动浏览器。`browser_close`、工人进程退出、服务启动时把对应名额还回去。`set_goal` 不读这本账。

这取代「环境模型决定还有没有容量、要不要再找一件活」。

---

## 5. 交付

工人点名交付物。车间不猜文件。两条出口：

1. **给人。** 沿现有登记进入资产 ingest。ingest 与是否发消息无关。
2. **给车间。** 同一份登记写入这张台的日志：路径加一句话。文件留在台上。后来的工人只因为上班时读过日志才知道它。已经在干的工人，决策轮里不再收到别人的新交付，只收到余量更新。

交付时工人把简短经过写入日志：步骤，以及结果落在哪。写一次。

外脑回答「这件事是怎么做的」时读这份日志，不再派一名工人去查。登记本身不发聊天消息。有人正在聊，外脑在当轮用日志里的经过来说。没人问，就安静。

---

## 6. 台上等待

工人自己碰上的等待，人留在台上。包括等响应、等软件安装、等用户输入。离台再回来的成本太高。

每种等待都有超时。超时了由这名工人自己处理，不另派一个人来查。

人的回复送到仍在这张台上的那名工人。等待期间这张台继续占着，不把位子让出来另找一件活。

这些等待不写入定时管理器。

---

## 7. 定时管理器

管理器单独记账。到点就派一名新工人上工。

它不关心台上谁在等，也不替第 6 节的等待计时。到点之前不占一张台。

现有 `employeeCalendar` 改成这个管理器。绑在 KPI 上的增量、到期后先进入容量循环再决定找什么活，删掉。

---

## 8. 外脑留下的事

外脑继续接对话，把抽象请求拆成可执行任务，派工，并在有人问起时读日志回答经过。

外脑不再维护长期职责账，不再在有空位时提案，也不再发「做完了」「我去做」「需要你补一句」这一类固定句。

---

## 9. 待删除

这些模块已从服务端删掉。下表是删除记录，**不要再加回来**。

| 模块 | 现在干什么 | 为什么删 |
|------|------------|----------|
| **kpiRegistry** | 长期 KPI 账本 | 不再有长期职责账 |
| **kpiManager** | R3–R7、burst 卫生、兼容续派 | 治理对象没了 |
| **kpiAdvancer** | `advance_kpi` → `set_goal` | 不再「推进一个 KPI」 |
| **kpiFailureCircuit** | 路线熔断，把禁路喂给找活 | 只为自主找活换方向 |
| **kpiCompletionJudge** | 心跳判定 KPI achieved | 任务完成就是这张台的交付 |
| **kpiBurstState** | 多 burst 资格、并行上限、连败 | KPI 卫生 |
| **kpiAwaitingReview** / **kpiAwaitingReviewLlm** | 审查等待，并释放员工容量 | 等待留在台上，不释放位子去找别的活 |
| **kpiSlotIdle** | ongoing KPI 的空闲槽 | 空了不找活 |
| **kpiFeedback** | momentum 选 KPI | 不再选长期目标 |
| **kpiSpawnCapacity** | 有容量就允许再派 | 容量填充找活 |
| **burstRunHistory** | 执行史，供找活去重和熔断 | 经过写在工作日志 |
| **burstProcessReport** | 组装 KPI 过程报告 | 外脑读日志 |
| **innerBrainKpiReuse** | 按 KPI 决定怎么派 `set_goal` | 新任务一律新工人、空台 |
| **performanceGoalEngine** | 绩效目标侧车 | OKR 侧车，早已不接入，一并删 |
| **adHocBurstAllocator** | 无 `kpi_id` 的一次性 burst | 可执行任务只有一条派工路径 |
| **inboundKpiRouter**（目录名 **inboundContextAssembler**） | 把 active KPI 注入对话 | 不再有 KPI 上下文 |
| **digitalEmployeeLoop** | 有容量就找下一件活 | 第 2 节没有这条来源 |
| **selfWorkPolicy** | 围绕 active KPI 提案 | 闲时找活 |
| **advanceWorkPackageBuilder** | 感知后决定推进、写日历或休眠 | 推进 KPI 的调配器 |
| **workflowEvolutionPolicy** / **workflowEvolutionStore** | 质检失败后向 SelfWork 提案修订 | 消费者是闲时找活 |
| **workflowForKpi** | 按 KPI 标签匹配可执行工作流，并优先交给找活 | 工作流不再挂在 KPI 上 |
| **completionReport** | 拼完成/部分完成的聊天正文 | 交付不发格式化消息；经过写在工作日志 |
| **outerHeartbeat** | KPI 结案、失约、找活补漏 | 作为找活时钟删除。NodeDef 淘汰不再挂在这根心跳上 |
| **staleBurstReaper** | 收僵尸 AWAITING | KPI 治理的 R5 |
| **autonomyJudge** | `hasAvailableCapacity`，等待不算忙 | 为了空位填活 |
| **autonomyPolicyStore** | 闲忙规则、找活闸门 | 同上 |
| **environmentSensorRegistry** / **environmentJournal** / **environmentChangeDetector** / **environmentModelFacade** | 给找活和容量看的环境模型 | 工人要的是车间余量，不是这套感知 |
| **resourceProbe** | 找活用的扁平负载快照 | 被环境模型接过，随之一起删 |
| **casualChatDispatcher** | 空闲时主动闲聊 | 闲时找事做 |
| **agentPersonality** | `idleChatProbability` | 只服务闲时闲聊 |
| **changeWatcher** | 等待解除后另 spawn 一名工人 | 等待不离台 |
| **awaitingNotify** | 固定句通知人来补输入 | 不发固定句；人留在台上等 |
| **imNotifyDedup** | 完成/等待通知去重 | 这两类通知删除 |
| **set_kpi** / **list_kpis** / **advance_kpi** / **achieve_kpi** / **view_kpi** | KPI 工具 | 账本删除 |

已经删掉、不要复活：`subKpiDecomposer`、`kpiCadence`、`burstReuse`、`strategyPlanner`、`strategyStore`、`dispatchByStrategy`、`scheduleNextKpiBurst`。

视图 `10-L2-KPI-Closed-Loop`、`10b-L3-Outer-KPI`、`11-L3-Outer-Autonomy`、`12-L3-Outer-Environment`、`13-L3-Outer-KPI-Manager`、`14-L3-Digital-Employee-Loop` 已从 `workspace.dsl` 去掉。对照专篇还在，不要按那些正文实现。

---

## 10. 改写

| 模块 | 留下 | 去掉 |
|------|------|------|
| **employeeCalendar** | 定时管理器：到点派一名新工人 | KPI 增量；到期后进入容量循环再找活 |
| **workspaceInbox** | 上班时读全部工作台日志一次 | 只读「同一个 KPI」的 sibling；用目录摘要代替日志 |
| **completionNotify** | 给人的交付 ingest | 格式化完成/部分/失败聊天消息 |
| **awaitingInboundResolver** | 把人的回复送到仍在台上的那名工人 | 解封后交给 changeWatcher 另 spawn |
| **imIntentClassifier** | 把用户的话交给外脑拆成可执行任务 | `kpi_create` / `kpi_update` |
| **outerToolExecutor** | `set_goal` 只接收可执行任务并派新工人 | KPI 工具；按 KPI 复用工作台 |
| **agentStatusChatCommand** | 可以回答台上谁在干活 | KPI 活动、槽位利用率找活口径 |

台上等待的超时记在这名工人自己的等待里，不新建第二份计时器。余量账本是 `workshopLedger`，不复活 `kpiSpawnCapacity` 或环境模型。

---

## 11. 这次不动

内脑怎么执行（DyFlow、工具、记忆、交付验票）、工作台目录、给人的 ingest、对话与是否说话、身份与渠道、LLM 用量账单、Executable Workflow 的注册和按步骤执行、Harness、NodeDef / drive9。它们不再被 KPI 心跳或闲时找活触发。

---

## 12. 对照专篇

| 专篇 | 标记 |
|------|------|
| [`DIGITAL-EMPLOYEE-AUTONOMY.md`](./DIGITAL-EMPLOYEE-AUTONOMY.md) | 待删除 |
| [`KPI-MANAGER-LAYER.md`](./KPI-MANAGER-LAYER.md) | 待删除 |
| [`KPI-CLOSED-LOOP.md`](./KPI-CLOSED-LOOP.md) | 待删除 |
| [`KPI-COMPLETION-JUDGE.md`](./KPI-COMPLETION-JUDGE.md) | 待删除 |
| [`KPI-ADVANCEMENT.md`](./KPI-ADVANCEMENT.md) | 待删除（原本已是历史） |
| [`KPI-ADVANCE-WORK-PACKAGE.md`](./KPI-ADVANCE-WORK-PACKAGE.md) | 待删除 |
| [`KPI-BURST-OUTCOME-EVALUATOR.md`](./KPI-BURST-OUTCOME-EVALUATOR.md) | 待删除 |
| [`KPI-BURST-LIFECYCLE-REMOVED.md`](./KPI-BURST-LIFECYCLE-REMOVED.md) | 待删除；它指向的续派也删 |
| [`ENVIRONMENT-MODEL.md`](./ENVIRONMENT-MODEL.md) | 待删除 |
| [`RESOURCE-AWARENESS-AUTONOMY.md`](./RESOURCE-AWARENESS-AUTONOMY.md) | 待删除（原本已是历史） |
| [`OUTER-HEARTBEAT-OVERSIGHT.md`](./OUTER-HEARTBEAT-OVERSIGHT.md) | 待删除 |
| [`INNER-BRAIN-AWAITING-LIFECYCLE.md`](./INNER-BRAIN-AWAITING-LIFECYCLE.md) | 待删除（离台再唤醒） |
| [`INNER-BRAIN-IM-NOTIFY-BOUNDARY.md`](./INNER-BRAIN-IM-NOTIFY-BOUNDARY.md) | 待删除（固定句通知） |
| [`STRATEGY-PLANNING-LAYER.md`](./STRATEGY-PLANNING-LAYER.md) | 待删除（原本已是历史） |
| [`INNER-BRAIN-SINGLE-INSTANCE.md`](./INNER-BRAIN-SINGLE-INSTANCE.md) | 待删除（原本已是历史） |
| [`EMPLOYEE-CALENDAR.md`](./EMPLOYEE-CALENDAR.md) | 改写为第 7 节 |
| [`INNER-WORKSPACE-INBOX.md`](./INNER-WORKSPACE-INBOX.md) | 改写为第 3 节的日志 |

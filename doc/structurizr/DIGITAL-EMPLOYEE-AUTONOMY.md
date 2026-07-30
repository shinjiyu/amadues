# 数字员工：容量驱动的自主工作与日程表（ADL 权威）

> **English:** Model the agent as a digital employee. Waiting for a human, a time, or an external event blocks only the dependent work; it does **not** make the whole employee or KPI busy. Whenever execution capacity is available, the employee first honors due calendar commitments, then proposes a valuable, non-duplicate action for an active KPI. Burst completion and calendar due events drive the loop immediately; heartbeat is a watchdog and recovery fallback.

> **状态**：P0–P3 已实现（见 §10）。本文取代“心跳是自主推进主发动机”“KPI cadence”“长 `wait_timer` 充当周期任务”的调度语义。

> **相关权威**：[`ENVIRONMENT-MODEL.md`](./ENVIRONMENT-MODEL.md)（感知）、[`KPI-MANAGER-LAYER.md`](./KPI-MANAGER-LAYER.md)（KPI 治理）、[`OUTER-HEARTBEAT-OVERSIGHT.md`](./OUTER-HEARTBEAT-OVERSIGHT.md)（监督）、[`INNER-BRAIN-AWAITING-LIFECYCLE.md`](./INNER-BRAIN-AWAITING-LIFECYCLE.md)（单 burst 恢复）、[`KPI-ADVANCE-WORK-PACKAGE.md`](./KPI-ADVANCE-WORK-PACKAGE.md)（**「推进」= 感知驱动的资源调配**）。

---

## 1. 产品模型：Agent 是数字员工

数字员工同时拥有：

1. **职责 / KPI**：长期要创造什么结果；
2. **日程表 / Calendar**：未来必须兑现的时间承诺；
3. **在途工作 / Burst**：当前实际占用执行容量的工作；
4. **待回复与外部依赖**：尚未就绪的承诺，不等于员工正在工作；
5. **可用容量**：还能否承接新的工作；
6. **自主找活能力**：空闲时围绕 active KPI 提出有明确产出的工作。

核心原则：

> **DE-1 阻塞附着于依赖，不默认扩散到整个 KPI 或员工。**

例如“等待用户确认小说标题”只阻塞依赖标题的发布工作，不应阻塞竞品调研、存稿、发布脚本测试或其它 KPI。

> **DE-2 等待释放容量。**

`AWAITING_TIME`、`AWAITING_EVENT`、`AWAITING_HUMAN` 都不是 `RUNNING`；只有实际执行中的 burst 占用 inner-brain 槽位。

> **DE-3 持续工作不是 `while(true)`。**

没有可执行价值时允许真正休眠；有价值工作或承诺到期时立即唤醒。空闲时零 token、零 LLM 调用。

---

## 2. “空下来”的唯一判定

产品语言使用“空下来”，实现语言使用 **`hasAvailableCapacity`**：

```text
hasAvailableCapacity =
  autonomy enabled
  AND free inner-brain slot > 0
  AND free LLM capacity > 0
  AND within token/cost budget
  AND no safety hard gate
  AND foreground reserve satisfied
```

该判定必须消费 `EnvironmentSnapshot.facets` + `AutonomyPolicy`，不得让 Calendar、SelfWorkPolicy 或 KPI Manager 各自重算。

### 2.1 不再作为“员工忙碌”的条件

| 条件 | 员工是否忙 | 正确处理 |
|---|---:|---|
| 某 burst 在等 `ask_user` | 否 | 只排除依赖该答案的提案 |
| 某 burst 在等明天时间 | 否 | 放入 Calendar；到期前不占槽 |
| 某 burst 在等外部数据 | 否 | 订阅事件；可做其它准备工作 |
| 有一个 RUNNING burst，但仍有空槽 | 部分忙 | 可继续填充剩余容量 |
| 用户正在前台对话 | 前台优先 | 预留前台容量；不必无条件停掉全部后台 |
| hardGate / 预算触顶 | 是 | 不派自主工作；到期日程进入延迟/升级流程 |
| `kpi_inner_goal.maxPerDay` / `cooldownMs` | **否（禁止）** | 旧心跳节流残留；**不得**挡住数字员工找活 |
| `minMsSinceLastAutonomousAction` | **否（禁止）** | 旧全员冷却；容量只看槽位/LLM/预算，不看墙钟间隔 |

> **DE-4 时间配额概念不存在于 KPI 找活。**  
> `hasAvailableCapacity` / `digitalEmployeeLoop` 只消费 hardGates 槽位、LLM、token/成本与前台预留。  
> schema 层：`taskTypes.kpi_inner_goal` **只有 `enabled` 一个字段**；`hardGates` **没有** `minMsSinceLastAutonomousAction` 字段。旧 `policy.json` 中的这些字段在 load/patch 时**删除**并回写（不是设成中性值——`cooldownMs=0`/`maxPerDay=999` 这种"归一化"仍会让 agent 向用户解释不存在的概念）。  
> `casual_chat` 的 cooldown/maxPerDay **保留**（防 IM 刷屏，不是找活产能；类型上为可选字段）。

### 2.2 可扩展环境传感器

沿用 `environmentSensorRegistry`。计划新增：

| Sensor | Facet | 作用 |
|---|---|---|
| `calendarSensor` | due 数、最早 due、missed 数 | 识别必须兑现的日程 |
| `commitmentSensor` | pending human/event/time、依赖摘要 | 防止生成依赖未满足的重复工作 |
| `foregroundDemandSensor` | 入站队列、活跃对话、预留槽位 | 前台优先而非全局停工 |
| `selfWorkOutcomeSensor` | 最近提案产出率、重复率、空转 streak | 评估不同创造性策略 |

Sensor 只读真相源，不直接派活。

---

## 3. 日程表：未来承诺，不是睡眠中的工作

### 3.1 Calendar 语义

外脑 Calendar 保存“何时必须尝试什么”，不持有一个睡眠中的 worker：

```typescript
interface CalendarCommitment {
  id: string;
  title: string;
  schedule: Once | Interval | Cron;
  action: PromptAction | ToolCallAction | SendMessageAction;
  kpiId?: string;
  expectedOutcome: string;
  priority: number;
  status: 'scheduled' | 'due' | 'running' | 'completed' | 'missed' | 'paused';
  nextRunAt: string | null;
}
```

### 3.2 复用现有 Scheduler

现有以下代码作为 Calendar 的实现基础，不另造 cron/parser/store：

- `packages/server/src/scheduler/`：Canonical facade；
- `packages/server/src/openkuroneko/scheduled-tasks/task-scheduler.ts`：cron / interval / once、持久化、missed recovery、失败暂停；
- `heartbeat-task-bridge.ts`：现为 heartbeat 驱动，目标改为可由 due timer / event 唤醒，heartbeat 保留补漏。

必须改造的旧语义：

1. `isAgentBusy()` 改为共享的 `hasAvailableCapacity()`；
2. 到期承诺不直接绕过统一调度执行，先进入 `digitalEmployeeLoop`；
3. 日程执行也必须经过 hardGates、优先级、幂等和 `set_goal` 唯一 spawn 边界；
4. 日程到期后若无容量，保留 `due` 并记录延迟，不静默跳过；
5. `HeartbeatTaskBridge` 不再意味着“只有心跳才检查日程”。

### 3.3 `wait_timer` 边界

`wait_timer` 仅用于单 burst 内短时技术等待。**外脑对话 prompt 不得引导内脑用 `wait_timer` 长睡实现周期巡检**：监控/周期类 KPI 的每个 burst 做一次检查并给出产出即结束，下一轮由数字员工调度触发。

`wait_timer` 合法场景：

- API 限速；
- 短暂 retry backoff；
- 已经开始的事务在短窗口内等待结果。

“明天发布”“每小时巡检”“下周复盘”等业务时间承诺必须写入 Calendar。长 `wait_timer` 不得代替日程。

### 3.4 双轨推进（实时 + 定时）— 外脑 prompt 必读

**同一 ongoing KPI 可以同时走两条轨**，不是二选一：

| 轨 | 谁触发 | 何时 |
|----|--------|------|
| **实时推进** | `digitalEmployeeLoop` → SelfWorkPolicy / repair / **ew_revision** / bootstrap / 对话 `advance_kpi` | 有容量、无健康在途；EW 质检失败的修订 explore **可穿透**未到期日历硬闸；日常 collect 仍只等日历 |
| **定时增量** | `employeeCalendar`（cron 承诺）→ `calendar_due` → 窄 increment `set_goal` | 基线有产物后 `ensurePeriodicCommitment`；到期再派。到期前不占槽 |

**禁止外脑 LLM 对用户说「系统没有 cron / 只有容量自动续派」**——`employeeCalendar` 就是 cron 式日程；容量续派是实时轨，不能代替日程。

> **日历不只服务 KPI**：聊天预约、一次性提醒、白名单 tool_call 与 KPI 增量同属 Calendar，经对话工具读写、经 loop 到期执行。权威设计见 [`EMPLOYEE-CALENDAR.md`](./EMPLOYEE-CALENDAR.md)。

对话 / 心跳 / `OUTER_ASYNC_ORCHESTRATION_GUIDE` / `set_kpi`·`advance_kpi`（及日历工具落地后的 `list_calendar` / `schedule_commitment`）说明必须一致。

---

## 4. 自主找活：SelfWorkPolicy

当无更高优先级的到期日程且仍有容量时，`SelfWorkPolicy` 围绕 active KPI 提案：

```typescript
interface SelfWorkProposal {
  kpiId: string;
  action: string;
  expectedOutcome: string;
  reason: string;
  strategyId: string;
  blockedBy?: string[];
  conflictsWith?: string[];
  /** ⏳ 已知 SOP：带上则 loop 应 set_goal(burstMode=execute, workflowRef) */
  workflowRef?: { id: string; version: string };
  burstMode?: 'explore' | 'execute';
}
```

> **「推进」精细化**：推进是 **资源调配**，前置是加厚 **日程 + 内脑** 感知（与 list/read 同源），再用简单规则决定起内脑 / 写日历 / 休眠。见 [`KPI-ADVANCE-WORK-PACKAGE.md`](./KPI-ADVANCE-WORK-PACKAGE.md)。禁止在盲区用 Duty 全文当默认 `action`。

> **确定性再跑**：当提案是「按已晋升流程再执行」时，必须 `burstMode=execute` + `workflowRef`，不得再发探索型 charter。见 [`EXECUTABLE-WORKFLOW.md`](./EXECUTABLE-WORKFLOW.md)。

### 4.1 合法提案契约

提案必须同时满足：

1. 关联 active KPI；
2. 有明确、可验收的 `expectedOutcome`；
3. 不依赖尚未满足的 human/time/event 条件；
4. 不与 RUNNING burst 写同一交付物；
5. 不重复最近已做或已失败且未换路线的工作；
6. 预期价值大于执行成本；
7. 能在本轮时间/token/工具权限预算内完成。

无法提出合法工作时返回 `null`，员工休眠；禁止为了“看起来忙”而生成工作。

### 4.2 创造性可替换、可测试（✅ P2 多策略 + 指标已落）

策略经 `createSelfWorkStrategy(strategyId)`（`self-work-strategies.ts`）注入，运行时由
`DigitalEmployeeRuntimeDeps.selfWorkStrategy` 或 `UTLRA_SELF_WORK_STRATEGY` 选择：

- `conservative`：优先明确 backlog / 未完成交付（默认）；
- `research_first`：优先信息增益；
- `tooling_first`：优先自动化、脚本与测试；
- `balanced`：写作 / 调研 / 工具 / 测试按最近动作数轮换起始角度；
- `llm_reflective`：LLM 基于环境、历史和 KPI 提案（✅ P3，`self-work-llm-policy.ts`）——注入 `SelfWorkLlmCaller`，只输出 JSON 提案或 `{"sleep":true}`；解析失败、非法提案或 LLM 异常一律回退 deterministic fallback（默认 conservative），LLM 永远只有提案权。

所有 deterministic 策略都是"角度优先序"的参数化（`AngleSelfWorkPolicy`）：首选角度重复/被熔断时换下一角度，全部耗尽才休眠。策略不是新的全局 `strategyPlanner`。它只有**提案权**，没有越过 hardGates、Calendar、KPI 状态或 `set_goal` 的写权。

**策略 A/B 灰度（✅ P3，`AbTestSelfWorkPolicy`）**：`UTLRA_SELF_WORK_STRATEGY=ab:conservative,balanced,...`（或 `ab` = 全部 deterministic 策略）。选择器读 `self-work-metrics.jsonl` 的 byStrategy 汇总：每个候选先探索满 `minTrialsPerStrategy`（默认 3 次提案），之后按 acceptance rate 利用最优者；被选策略提案为 null 时按顺序回退其余候选。提案的 `strategyId` 保持各自真实 id，指标归因不失真。

评估指标（`self-work-metrics.ts`，loop 日志回调喂入 `autonomy/self-work-metrics.jsonl`，`summarizeSelfWorkMetrics` 纯函数汇总）：

- proposal acceptance rate（accepted / 提案数）✅；
- duplicate proposal rate（duplicate_action + route_blocked 占比）✅；
- no-progress streak（末尾连续未派活事件数）✅；
- 按 strategyId 分组 accepted/rejected（策略 A/B 对比）✅；
- deliverable / expectedOutcome 达成率、每有效产出的 token / 时间成本、KPI 饥饿时间（⏳ P3，需接 burst outcome 评价）。

---

## 5. 统一运行循环

### 5.1 触发源

`digitalEmployeeLoop.trigger(reason)` 接受：

| 触发 | 时机 |
|---|---|
| `burst_finished` | worker DONE / ERROR / STOPPED / AWAITING 后 |
| `calendar_due` | 日程到期 |
| `dependency_resolved` | 人类回复或外部事件满足依赖 |
| `inbound_drained` | 用户前台队列处理完且释放容量 |
| `policy_changed` | autonomy / budget / slot policy 变化 |
| `heartbeat_fallback` | 周期补漏与监督 |

触发必须 coalesce + single-flight，避免同一时刻多次事件重复派发。

### 5.2 调度顺序

```text
trigger
  → collect EnvironmentSnapshot
  → hasAvailableCapacity?
      no  → record reason; sleep
      yes → due Calendar commitment?
              yes → dispatch commitment
              no  → SelfWorkPolicy.propose(active KPIs, environment, pending deps, history)
                        null → sleep
                        proposal → validate → set_goal
  → dispatch 成功后重新采集容量
  → 仍有容量可继续填槽，但受单次 trigger 派发上限保护
```

优先级：

```text
用户明确请求
  > 到期日程承诺
  > 已满足依赖的恢复工作
  > 围绕 active KPI 的自主工作
  > 主动闲聊
  > 休眠
```

### 5.3 心跳的新定位

Heartbeat 是经理巡检 / watchdog：

- death / stuck 检测；
- KPI 完成判定；
- R3/R4/R5 清理；
- R7 / 成本 / 安全监督；
- Calendar missed 扫描；
- 对漏掉的完成事件执行 `heartbeat_fallback`。

Heartbeat 不再是连续推进的唯一主时钟，也不直接决定下一份创造性工作。

---

## 6. 现有机制按员工场景重新判定

### 6.1 `ask_user`

员工向主管提问后：

- 问题是一项**未满足依赖**；
- 提问对应的工作可 AWAITING；
- 员工可做不依赖答案的同 KPI 工作和其它 KPI；
- 用户回复后 `awaitingInboundResolver` 仍确定性 resolve 原 burst；
- `hasBlockingAskUserForKpi` 的“KPI 全局 gate”目标删除，改为提案依赖过滤。

### 6.2 同 KPI 并行

员工可同时委派“写存稿”“竞品调研”“发布脚本测试”，但不能并行改同一章节或执行同一发布动作。

因此：

- 全局容量仍由 hardGates 控制；
- `maxParallelBurstsPerKpi` 仅作防御性上限；
- 是否可并行主要由 `conflictsWith` / 交付物冲突决定，不再仅按 KPI id 一刀切。

### 6.3 R7 连败熔断（路线级，✅ P2 已实现）

连续失败首先表示“某条路线需要停止”，不必然表示“员工放弃整个职责”：

1. 优先熔断重复 action / tool / strategy；
2. 允许 SelfWorkPolicy 换独立方向；
3. 只有多方向失败、系统性权限/服务阻塞，或无合法替代工作时才 pause KPI 并升级给人。

实现语义（`kpi-burst-state.analyzeConsecutiveFailureRoutes` + `kpi-failure-circuit`）：

- **路线（route）** = burst goal/charter 的规范化签名（压空白、lowercase、截断）；同一 action 重试属同一路线。
- **同路线连败 ≥ 阈值** → 该路线进入 `blockedRoutes`（不 pause KPI，不发 IM）；`SelfWorkContext.blockedRoutes` 注入提案校验，命中即 `route_blocked` 拒绝，策略必须换独立方向。
- **多路线（≥2 条不同路线）连败合计 ≥ 阈值** → 视为系统性失败，KPI `paused` + IM 升级（沿用原 R7 通道）。
- 兼容兜底：burst 无 goal 信息（无法分路线）时退回 KPI 级计数。
- `evaluateKpiAdvanceEligibility` 的 KPI 级 gate 保留，防止兼容 advance 路径绕过。

### 6.4 前台对话（自适应前台预留，✅ P3）

用户正在聊天表示前台优先，而非全公司停工。`hasAvailableCapacity` 实现语义：

- **前台活跃**（`inbound.outerLoopActiveThreads > 0` 或 `orchestratorQueuedTotal > 0`）→ 预留 `hardGates.foregroundReserveSlots`（默认 1）个内脑槽：`freeInnerSlots = max(0, maxRunningInnerBrains − running − reserve)`；扣除后仍有剩余槽即可继续后台派发，扣完则 `foreground_reserved` 休眠；
- **前台安静** → 预留归零，全部槽可用于自主工作（自适应，无需人工切换）；
- **高压入站**（`orchestratorQueuedTotal > blockIfOrchestratorQueuedAbove`）→ `inbound_pressure` 全面暂停自主派发（hardGate 语义保留）；
- 不抢占不可安全中断的 RUNNING burst；
- 旧 `blockIfOuterLoopActive` 全停语义**默认关闭**（`defaultAutonomyPolicy` 置 `false`，存量 policy.json 已迁移）；字段保留为显式 opt-in 兼容闸，仅作用于 heartbeat 兼容 advance 路径（`evaluateKpiSpawnCapacity`），数字员工主路径不读。

### 6.5 有边界的工作包（旧称「一小步 sprint」）

替换为“有边界的工作包”（见 [`TERMINOLOGY.md`](./TERMINOLOGY.md)：一轮执行 = **burst**）：

- 有明确 expectedOutcome；
- 有 token / 时间 / 工具范围预算；
- 到达产出、预算、阻塞或风险边界才结束；
- 禁止任意做一小步就频繁交接，也禁止无限单 burst。

---

## 7. 组件边界

| Component | 职责 | 不做 | 计划路径 |
|---|---|---|---|
| `digitalEmployeeLoop` | 多触发 coalesce；按优先级填充可用容量 | 不自行计算容量，不直接 fork | `outer/digital-employee-loop.ts` |
| `employeeCalendar` | 持久化日程、due/missed、发 `calendar_due` | 不判断 KPI，不绕过统一派发 | `scheduler/` facade + existing scheduled-tasks |
| `selfWorkPolicy` | 为 active KPI 生成可验收提案；策略可注入 | 不越过 hardGates，不直接 spawn | `outer/self-work-policy.ts` |
| `environmentModel` | 可插拔感知 + 历史 + derived | 不选工作 | existing `outer/environment/` |
| `autonomyJudge` / capacity | 判定 `hasAvailableCapacity` | 不选择 KPI / 工作 | existing `outer/environment/` |
| `kpiManager` | KPI 状态、完成、R3–R7、burst 卫生 | 不作为唯一循环时钟，不生成创造性提案 | existing `outer/kpi/` |
| `outerToolExecutor.set_goal` | 唯一物理 spawn | 不做策略 | existing |
| `outerHeartbeat` | watchdog、监督、fallback | 不作为主发动机 | existing |

---

## 8. 小说数字员工验收场景

给定：

- KPI：“持续创作并运营小说”，status=active；
- Calendar：明天 09:00 发布，10:00 拉取昨日数据；
- 当前 20:00，有一个空闲 inner-brain 槽；
- “读取明日数据”尚未到期；
- “最终书名”在等用户确认。

期望：

1. 不派“现在读取明日数据”；
2. 不因等待书名而暂停整个 KPI；
3. 可提案：写存稿、竞品调研、发布脚本测试、数据采集工具；
4. 每个提案有明确 expectedOutcome；
5. 09:00 `calendar_due` 优先触发发布；
6. 发布完成立即重新判断容量，不等下一次心跳；
7. 10:00 才允许执行拉取数据；
8. 无合法工作或预算触顶时真正休眠。

---

## 9. 测试策略（先红后绿）

| 阶段 | 红测 |
|---|---|
| P0 容量语义 | AWAITING human/time/event 不占 RUNNING 槽；有剩余槽即 available |
| P0 依赖收窄 | 一个 ask_user 不阻塞同 KPI 的独立提案；依赖该答案的提案被拒 |
| P0 日程表 | 未到期不执行；到期只派一次；无容量保持 due；重启补 missed |
| P1 事件续派 | burst exit 后立即 trigger；并发 trigger coalesce；不重复 set_goal |
| P1 提案契约 | 缺 expectedOutcome、重复、冲突、依赖未满足 → reject |
| P2 创造性实验 ✅ | 各策略在同一 fixture 下输出可比较提案与指标（`self-work-strategies.test.ts` + `self-work-metrics.test.ts`） |
| P2 R7 收窄 ✅ | 某路线三连败不阻塞独立方向；系统性失败才 pause KPI（`kpi-failure-circuit.test.ts`） |
| P3 watchdog ✅ | 漏 completion event 时 heartbeat fallback 恢复推进（`outerHeartbeatDigitalEmployee.component.integration.test.ts`） |
| P3 前台预留 ✅ | 前台活跃预留 N 槽仍可后台派发；扣完 `foreground_reserved`；安静时预留归零；高压 `inbound_pressure` 全停（`kpi-spawn-capacity.test.ts`） |
| P3 llm_reflective ✅ | fake caller 返回 JSON → 合法提案；`{"sleep":true}` → 休眠；解析失败/非法/异常 → fallback（`self-work-llm-policy.test.ts`） |
| P3 策略 A/B ✅ | 探索期轮询未满 minTrials 候选；之后按 acceptance rate 利用；被选策略 null 时回退其余候选（`self-work-strategies.test.ts`） |

所有计划测项先在 [`COMPONENT-TEST-MAP.md`](./COMPONENT-TEST-MAP.md) 标 `⏳`。

---

## 10. 迁移顺序

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P0** | ADL + Calendar 纳入架构；统一 `hasAvailableCapacity`；ask_user 不再作 KPI 全局派发 gate；missed 保持 due | ✅ |
| **P1** | `digitalEmployeeLoop` single-flight/coalesce；burst / calendar / dependency 事件；heartbeat fallback | ✅ |
| **P2** | 多策略 `createSelfWorkStrategy`（conservative/research_first/tooling_first/balanced）+ 指标 JSONL；R7 路线级熔断（blockedRoutes / route_blocked）；burst exit 写 `burstRunHistory` 供去重与路线分析 | ✅ |
| **P3** | heartbeat 降 watchdog 且禁止直接 set_goal；`llm_reflective` 策略（LLM 提案 + deterministic fallback）；自适应前台预留（`foregroundReserveSlots`）；策略 A/B 灰度（`ab:` spec + 指标驱动探索/利用） | ✅ |

兼容期：

- 读取 legacy `KpiRecord.cadence/nextDueAt`，不再作为调度权威；
- 迁移长 `wait_timer` 为 Calendar commitment；
- 数字员工 runtime 已接线时，heartbeat 的 `kpiManager` 只治理不 advance；fallback 统一触发 `digitalEmployeeLoop`；
- 现有 Scheduler store/schema 优先复用，不建立第二份日程真相；
- 启动 load `autonomy/policy.json` 时剥掉旧 KPI 日配额/冷却与 `minMsSinceLastAutonomousAction`（见 §2.1 DE-4）；`kpi-manager` 兼容 advance 路径也不再读这些字段。

---

## 11. 不变量

1. `set_goal` 仍是唯一 spawn API；
2. Calendar、SelfWorkPolicy、heartbeat 均不能绕过 hardGates；
3. 同一 trigger / commitment 必须幂等；
4. 等待不占容量，但依赖未满足的工作不得执行；
5. 用户明确请求与到期承诺优先于自主找活；
6. 无明确价值时允许休眠；
7. 所有自主提案、拒绝、派发和熔断必须写 action-log；
8. 事件驱动失败时 heartbeat 必须能恢复，但不得制造第二调度真相。

---

## 12. 修订

| 日期 | 说明 |
|---|---|
| 2026-07-21 | 初版：以数字员工模型统一容量、Calendar、SelfWorkPolicy、事件续派与 heartbeat watchdog；重新界定 ask_user / wait_timer / R7 / 并发。 |
| 2026-07-21 | P0/P1 代码落地：统一容量、Scheduler Calendar adapter、事件 loop、保留 missed due、依赖级 ask_user、heartbeat watchdog/fallback；P2/P3 保持部分实现。 |
| 2026-07-21 | P2 落地：多策略 SelfWorkPolicy（角度轮询）+ 指标 JSONL；R7 下沉路线级（单路线 → blockedRoutes，不 pause KPI；多路线/不可识别 → pause）；burst exit 统一写 burstRunHistory。 |
| 2026-07-21 | P3 落地：`llm_reflective`（SelfWorkLlmCaller + JSON 契约 + fallback）；自适应前台预留（前台活跃扣 `foregroundReserveSlots`，高压 `inbound_pressure` 全停，`blockIfOuterLoopActive` 仅留兼容路径）；`AbTestSelfWorkPolicy`（探索满 minTrials 后按 acceptance rate 利用）。 |
| 2026-07-21 | DE-4：废弃 KPI 时间配额作产能闸；`loadAutonomyPolicy` 归一化旧 `maxPerDay`/`cooldown`/`minMs`；`kpiTaskEligible` 不再检查日配额。 |
| 2026-07-21 | DE-4 收尾：`blockIfOuterLoopActive` 默认 `false`（前台只走预留槽）；外脑对话 prompt 不再教内脑 `wait_timer` 长睡做周期巡检（周期续派由数字员工调度负责）；`kpi_inner_goal` 停写日计数；policy 工具暴露 `foreground_reserve_slots` 并标废弃旋钮。 |
| 2026-07-22 | 交叉 [`KPI-ADVANCE-WORK-PACKAGE.md`](./KPI-ADVANCE-WORK-PACKAGE.md)：**推进 = 感知驱动调配**（日程+内脑 facet）；非重型 WP 状态机。 |
| 2026-07-22 | §3.4 **双轨推进**：外脑 prompt/工具说明必须教「实时 SelfWork + Calendar 定时」并存；禁止声称无 cron。 |
| 2026-07-22 | 日历升格为一等工具（聊天预约等）：见 [`EMPLOYEE-CALENDAR.md`](./EMPLOYEE-CALENDAR.md)。 |
| 2026-07-22 | 名词统一：执行轮次一律称 **burst**；见 [`TERMINOLOGY.md`](./TERMINOLOGY.md)。 |
| 2026-07-25 | **W15**：EW 自优化——质检失败 → `ew_revision` explore（穿透日历硬闸）→ 同 id promote；日常 collect 仍只跟日历 |
| 2026-07-21 | DE-4 彻底化：从 schema 删除概念而非归一化——`kpi_inner_goal` 仅剩 `enabled`，`hardGates` 删除 `minMsSinceLastAutonomousAction`；policy 工具不再暴露/打印这些旋钮；load 时删除旧字段并回写。 |

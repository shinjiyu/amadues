# 外脑日历（Employee Calendar）一等工具设计（ADL）

> **English:** Calendar is a **first-class outer commitment store + tool surface**, not a KPI-only backend ensure. Chat can schedule appointments and one-shots; the digital-employee loop remains the **sole due-execution path**. Complements [`DIGITAL-EMPLOYEE-AUTONOMY.md`](./DIGITAL-EMPLOYEE-AUTONOMY.md) §3、[`KPI-ADVANCE-WORK-PACKAGE.md`](./KPI-ADVANCE-WORK-PACKAGE.md).
>
> **状态**：设计权威；**C1–C4 已落地**（Port upsert/list/cancel/pause、对话工具、due 经 loop、ensure 统一 upsert、tool_call 白名单）。

---

## 0. 问题陈述

当前实现把日历收窄成「KPI 基线后后台 ensure 一条 cron」，对话环看不到、调不到。这不合理：

| 错误收窄 | 正确范围 |
|----------|----------|
| 日历 ≈ KPI 日增量 | 日历 = **任意未来必须兑现的承诺** |
| 只有系统 ensure 写入 | 对话 / 推进 / 系统均可写入，**同一 store** |
| LLM 说「没有日历工具」 | 对话有 `list` / `schedule` / `cancel`；执行仍不绕过 loop |

聊天预约（「明天下午三点提醒我开会」「周五再跟进这篇」）与 KPI 周期采集是**同一抽象**的不同 `purpose`，不是两套系统。

---

## 1. 分层（严格边界）

```text
┌─────────────────────────────────────────────────────────┐
│ 对话环 outerConversationLoop / outerToolExecutor         │
│   list_calendar · schedule_commitment · cancel/pause…    │  ← 写/读 API
└────────────────────────────┬────────────────────────────┘
                             │ create / list / mutate
                             ▼
┌─────────────────────────────────────────────────────────┐
│ employeeCalendar（facade）                                │
│   语义：Commitment CRUD + 视图 + 幂等键                   │
│   存储：复用 Scheduler / TaskScheduler（不另造库）         │
└────────────────────────────┬────────────────────────────┘
                             │ calendar_due / listDue
                             ▼
┌─────────────────────────────────────────────────────────┐
│ digitalEmployeeLoop（唯一到期执行入口）                    │
│   due 优先于 SelfWork → hardGates → 按 action 兑现        │
│   set_goal / advance_kpi / post_to_im / tool_call …      │
└─────────────────────────────────────────────────────────┘
```

**禁止：**

1. 对话工具直接 `set_goal`「假装到期」（到期必须走 loop，以便容量与优先级统一）。
2. 内脑 `wait_timer` 长睡代替业务日程（DE §3.3 不变）。
3. 再发明第二套 cron 存储或旁路 heartbeat 偷偷执行。

**允许：**

1. 对话在用户确认后立刻 `schedule_commitment`（once / cron / interval）。
2. 推进层继续 `ensurePeriodicCommitment`（KPI purpose，幂等键）。
3. 心跳只扫 missed / overdue 质控，不替代 loop 执行。

---

## 1.1 两维矩阵（权威摘要）

设计只认两轴：**谁可以 CRUD**，以及 **到期可以驱动什么**。其它（UI、prompt）都挂在这两轴上。

### A. 谁可以 CRUD

| Actor | Create | Read | Update（改时间/文案/暂停） | Delete/Cancel | 范围限制 |
|-------|--------|------|------------------------------|---------------|----------|
| **人类（经对话）** | ✅ 授权外脑调 `schedule_*` | ✅ `list_calendar` / 问进度 | ✅ | ✅ | 本 agent；高副作用可要求口头确认 |
| **外脑对话 LLM** | ✅ 工具 | ✅ | ✅ | ✅ | 仅本 agent；遵守 purpose/上限/白名单 |
| **推进 / digitalEmployeeLoop** | ✅ 仅 `kpi_increment` ensure | ✅ listDue / byKpi | ⚠ 幂等 ensure 可刷新 prompt/nextRun | ❌ 不随意删用户预约 | 系统写入；`createdBy=system` |
| **outerHeartbeat** | ❌ | ✅ missed/overdue 质控读 | ⚠ 仅标记 missed 暴露 | ❌ | 不建、不兑现 |
| **内脑** | ❌ | ❌ | ❌ | ❌ | 业务定时禁止；只用短 `wait_timer` |
| **Ops / HTTP API**（可选后续） | ✅ | ✅ | ✅ | ✅ | 鉴权后等同 agent 工具面 |
| **其它 agent** | ❌ | ❌ | ❌ | ❌ | 禁止跨 agent 改日历 |

不变量：

1. **写入口**只有：对话工具、推进 ensure、（可选）Ops——全部进同一 `employeeCalendar` store。  
2. **读**可多处（对话、facet、心跳质控、Dashboard），但真相只有 Scheduler。  
3. 内脑 **零 CRUD**。

### B. 日历到期可以驱动什么

到期后**唯一执行者**是 `digitalEmployeeLoop`（先 hardGates / 容量）。可驱动的功能是封闭枚举：

| 驱动能力 | 对应 action / purpose | 典型场景 | 占内脑槽？ |
|----------|----------------------|----------|-----------|
| **发 IM 提醒 / 回访** | `SendMessageAction` · `chat_appointment` | 「明天下午提醒我开会」 | 否 |
| **派一次性内脑** | `PromptAction` → `set_goal` · `one_shot_task` | 「到点帮我搜一版竞品」 | 是 |
| **派 KPI 增量 burst** | `PromptAction` → `set_goal(kpiId)` · `kpi_increment` | 每日采集 | 是 |
| **调外脑白名单工具** | `ToolCallAction` · `tool_call` | 到期刷 list、打点、有限副作用 | 视工具 |
| **（不驱动）SelfWork 找活** | — | due 为空时才轮到 SelfWork | — |
| **（不驱动）内脑自己醒来** | — | 禁止用日历代替；也不许内脑写日历 | — |

明确**不是**日历直接驱动的：

- 不直接改 KPI `achieved` / pause（那是 kpiManager）  
- 不直接跑心跳质控逻辑（心跳只读 missed）  
- 不绕过容量硬起内脑（无槽则保持 `due`）

优先级：**任意 purpose 的 due ≫ SelfWork**；`chat_appointment` 未到期不阻塞无关 KPI。

---

## 2. 承诺模型（加严）

在 DE §3.1 基础上**强制**带 `purpose` 与稳定幂等键；action 与现有 Scheduler `TaskAction` 对齐。

```typescript
type CalendarPurpose =
  | 'kpi_increment'      // KPI 周期增量（ADV-6 ensure）
  | 'chat_appointment'   // 聊天预约：到期提醒 / 跟进话术
  | 'one_shot_task'      // 一次性：到期派内脑或发 IM
  | 'tool_call'          // 到期调已注册外脑工具（白名单）
  | 'system';            // 系统内部（勿对用户枚举细节）

interface CalendarCommitment {
  id: string;
  /** 幂等键：同 agent 下唯一；对话创建时由工具生成或调用方传入 */
  calendarKey: string;
  title: string;
  purpose: CalendarPurpose;
  schedule: Once | Interval | Cron;
  action: PromptAction | ToolCallAction | SendMessageAction;
  /** KPI 绑定时必填；纯聊天预约可空 */
  kpiId?: string;
  /** 预约来源 thread，便于到期回帖 */
  originThreadId?: string;
  originUserSid?: string;
  expectedOutcome: string;
  priority: number;
  status: 'scheduled' | 'due' | 'running' | 'completed' | 'missed' | 'paused';
  nextRunAt: string | null;
  createdBy: 'user' | 'agent' | 'system';
}
```

### 2.1 `calendarKey` 约定

| purpose | key 形态 | 说明 |
|---------|----------|------|
| `kpi_increment` | `{kpiId}:increment` | ADV-6 已有；同 KPI 至多一条活跃 |
| `chat_appointment` | `chat:{threadId}:{slug}` 或调用方显式 key | 同 thread 同 slug 幂等更新 |
| `one_shot_task` | `once:{uuid}` 或业务 slug | once 执行完 → completed |
| `tool_call` | `tool:{name}:{slug}` | 工具名须在白名单 |

### 2.2 到期兑现（按 purpose）

| purpose | due 时 loop 行为 |
|---------|------------------|
| `kpi_increment` | 窄 prompt → `set_goal`（绑定 kpiId）；无容量则保持 due |
| `chat_appointment` | 默认 `send_message` 回 originThread；可选附带「是否现在派内脑」由下一条用户话决定——**预约本身不强制 spawn** |
| `one_shot_task` | `prompt` → `set_goal`（可无 kpi）或 `send_message`；按 action 类型 |
| `tool_call` | 仅允许白名单工具（如 `list_kpis` 只读类默认禁止副作用；副作用工具须显式允许） |

**聊天预约默认偏「提醒 / 回访」**，不默认同 KPI 抢容量起内脑；若用户说「到时候帮我搜一下」，action 用 `prompt`/`one_shot_task` 并写清 expectedOutcome。

---

## 3. 对话环工具（一等公民）

挂在 `outerToolExecutor` / `OUTER_TOOL_DEFS`，与 `set_kpi` 同级。

| 工具 | 职责 | 硬约束 |
|------|------|--------|
| `list_calendar` | 列本 agent 承诺；可滤 purpose / kpiId / status / thread | 只读；含 nextRunAt、missed |
| `schedule_commitment` | 创建或幂等 upsert（靠 calendarKey） | 必须 purpose + schedule + action 或可推导的模板；禁止空 title |
| `cancel_commitment` | 取消 / 归档 | 须 id 或 calendarKey |
| `pause_commitment` / `resume_commitment` | 暂停 / 恢复 | 同上 |

### 3.1 `schedule_commitment` 入参（对话友好）

```text
purpose: chat_appointment | one_shot_task | kpi_increment | tool_call
title: string
when: ISO8601 | cron 表达式 | { in_minutes: n }   // 工具层规范化成 ScheduleRule
action_kind: remind | spawn_goal | tool_call
  remind     → SendMessageAction（默认回当前 thread）
  spawn_goal → PromptAction（content=goal 摘要）
  tool_call  → ToolCallAction（name 白名单）
kpi_id?: string          // kpi_increment 必填
calendar_key?: string    // 缺省按 §2.1 生成
expected_outcome: string
```

用户口语「明天下午三点提醒我交周报」→ 对话 LLM 调 `schedule_commitment(purpose=chat_appointment, action_kind=remind, when=…)`，**不要** `set_goal` 让内脑 sleep 到明天。

### 3.2 Prompt 义务（对话 + 心跳）

1. **有**日历工具；禁止说「没有日历 / 没有 cron」。
2. 业务定时 / 聊天预约 → `schedule_commitment`；KPI 日更也可显式 schedule，或依赖 ensure。
3. 查询「有没有定时」→ `list_calendar`，勿臆测。

（实现后替换当前仅文字双轨、无工具的临时措辞。）

---

## 4. 与推进 / SelfWork 的优先级

不变式（DE §5 流程图加严）：

```text
有容量?
  no  → sleep（due 保留）
  yes → listDue 非空?
          yes → 按 priority 执行最高 due（所有 purpose）
          no  → SelfWork / ensure kpi_increment（仅缺日历的 KPI）
```

- **任意 purpose 的 due 都优先于 SelfWork**（含聊天提醒）。
- `kpi_increment` 未到期 → SelfWork 禁止对该 KPI 整单增量抢跑（ADV 已有）。
- `chat_appointment` 未到期 → **不**阻塞无关 KPI 的 SelfWork。

---

## 5. 安全与滥用

| 规则 | 说明 |
|------|------|
| 每 agent 活跃承诺上限 | 防御性 cap（建议默认 50；可 policy 配） |
| cron 最短间隔 | 建议 ≥ 5min，防对话刷爆 |
| tool_call 白名单 | 默认仅只读或显式允许列表；禁止任意 shell |
| 人类确认 | 高副作用（周期性 spawn）可由 policy 要求用户一句话确认后再 schedule |
| 审计 | 每次 schedule/cancel 写 autonomy action-log |

---

## 6. 感知与可观测

- Environment `calendar` facet：dueCount / missedCount / byPurpose 计数。
- `list_inner_brains` / Dashboard：可选挂「本 KPI 下一条日历」。
- `advance-metrics`：保留 `calendar_ensure`；新增 `calendar_schedule_from_chat` 计数。

---

## 7. 与现有代码的映射

| 已有 | 本设计 |
|------|--------|
| `scheduler/employee-calendar.ts` | 扩展 Port：通用 `upsertCommitment` / `list` / `cancel`；ensure 变为 kpi_increment 特化 |
| `CreateTaskRequest` + `TaskAction` | 直接承载 schedule + action；metadata 写 purpose / calendarKey / kpiId / originThread |
| `digital-employee-runtime` due 执行 | 按 purpose 分支；今日仅 prompt→set_goal 须扩 send_message |
| `OUTER_TOOL_DEFS` | **新增** §3 四工具 |
| 对话 prompt | 教工具用法，禁止否认日历 |

---

## 8. 分期

| 阶段 | 内容 | 状态 |
|------|------|------|
| **C0** | ADL（本文）+ modules-catalog / COMPONENT-TEST-MAP 挂载 | ✅ 本文 |
| **C1** | Port 扩展 + `list_calendar` / `schedule_commitment` / `cancel`；once + remind（send_message） | ✅ |
| **C2** | due 执行分支：remind vs spawn；对话 prompt / 工具说明 | ✅ |
| **C3** | `kpi_increment` 与 ensure 统一走 upsert；facet byPurpose；上限与 cron 地板 | ✅ |
| **C4** | tool_call 白名单 + 指标 + 组件测 | ✅ |

验收（聊天）：用户说「明天下午三点提醒我 X」→ `list_calendar` 能看到 → 到期 IM 收到提醒 → 期间 SelfWork 仍可跑无关 KPI。

---

## 9. 测试地图

| 测项 | 断言 | 状态 |
|------|------|------|
| schedule once remind 幂等 key | 二次 schedule 不双写 | ✅ |
| due remind 优先于 SelfWork | loop 先 send_message | ✅（既有 due≫SelfWork；remind 经 trigger→send_message） |
| due 无容量 | 保持 due，不丢 | ✅（既有 due 保留） |
| 对话无日历工具时的否认 | 实现后禁止（prompt + 工具存在） | ✅ |
| kpi_increment 与 chat 共存 | 同 agent 两条不同 purpose | ✅ |

---

## 10. 修订

| 日期 | 说明 |
|------|------|
| 2026-07-22 | 初版：纠正「日历仅 KPI 后台」；对话一等工具 + purpose 分型 + 唯一执行入口 |
| 2026-07-22 | 名词：到期派活称 **burst**（不用 sprint）；见 [`TERMINOLOGY.md`](./TERMINOLOGY.md) |

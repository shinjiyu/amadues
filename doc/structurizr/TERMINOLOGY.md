# 架构名词表（权威）

> **English:** Canonical vocabulary. Dispatch terms as of 2026-10-16 are in [`WORKSHOP.md`](./WORKSHOP.md): workshop, bench, worker, bench log, remainder, executable task, timer manager.
>
> **2026-10-16**：派活名词以车间为准。下表里的 KPI、SelfWork、digitalEmployeeLoop、work package、charter（作为长期职责的本轮章程）标为待删除，代码里的标识符还在。工人 / 工作台对应现在代码里的一次执行和它的 workspace。

---

## 1. 核心对象（必须统一）

| 权威词 | 含义 | 禁止再用（同义混用） | 代码锚点 |
|--------|------|----------------------|----------|
| **车间** | 共享工作环境；浏览器和登录会话记在这里 | 不要叫成 KPI 或数字员工 | `workshop/resource-ledger.ts` |
| **工人** | 一次可执行任务的执行，坐一张空台 | 新叙述不用 burst | 代码里仍是一次 `set_goal` / `instanceId` |
| **工作台** | 这名工人独占来写的目录，带一份工作日志 | 新叙述不用 workspace 当派活名词 | `task-ib-…` |
| **余量** | 每个决策轮给工人看的车间资源剩余 | 不是 `hasAvailableCapacity` 找活闸门 | `workshop/resource-ledger.ts` |
| **KPI** | **【待删除】** 长期目标身份 | 车间不再记长期职责账 | 代码已删 |
| **burst** | **【改称工人】** 代码标识符仍在 | **sprint**、KPI sprint | `instanceId`、`set_goal` |
| **workspace** | **【改称工作台】** | — | `task-ib-…` |
| **charter / 本轮章程** | **【待删除】** 作为 KPI 本轮目标的用法 | 可执行任务由外脑拆好再派 | `goal.md` |
| **work package** | **【待删除】** 找活调配用的工作包 | 见 WORKSHOP.md | advance allocator |
| **commitment / 定时** | **【改写】** 到点派一名工人 | 不替台上等待计时，不进入容量找活 | `employeeCalendar` |
| **SelfWork** | **【待删除】** 空闲时围绕 KPI 提案 | 车间没有这条活的来源 | 代码已删 |
| **digitalEmployeeLoop** | **【待删除】** 有容量就找下一件活 | 同上 | 代码已删 |
| **Executable Workflow（EW）** | 已冻结、可逐步验收的**确定性工作流**契约；Skills 是其一种载体 | 把 EW 叫成「又一个 skill」 | [`EXECUTABLE-WORKFLOW.md`](./EXECUTABLE-WORKFLOW.md) |
| **HarnessSpec（H）** | 内脑一次可寻址的 harness 快照（nodes/skills/EW/assets） | 把单条 skill 或进程状态叫 H | [`HARNESS-RSI.md`](./HARNESS-RSI.md) |
| **harness analyze** | 周期读轨迹出 soft findings（类 pstune analyze） | 仅失败才复盘；无 gate 直接改 active | 同上 §4.1 |
| **harness upgrade / rollback** | 改 `.brain/harness/active.json` 指针（须先 gate） | 无门控写 skill；外脑改 KPI 策略 | 同上 |
| **restart-with-H** | 同 charter 在新 active H 下再进 DESIGN→RUN | `POST …/restart` 进程恢复 | 同上 |
| **BurstMode** | 本发 burst 自由度：`explore`（默认可 redesign）\| `execute`（绑 EW，禁 redesign） | 与 KPI / SelfWork 混称 | `set_goal.burstMode`（⏳） |
| **WorkflowKind** | EW 载体：`skill_md` / `browser_playbook` / `frozen_dag` / `shell_pipeline` / … | 与 BurstMode 混用 | 同上 |
| **promote（工作流）** | 探索产物 → 带版本的 EW | 仅 `record_fact` / 写 skill 提示而不冻结执行契约 | `workflowPromote`（⏳） |

### 1.1 `burst` vs 旧称 `sprint`

```text
KPI（长期）
  └─ burst #1   ← 旧口头语「sprint 1」
  └─ burst #2   ← 旧口头语「sprint 2」
```

- **文档与 ADL 一律写 burst。**
- 对用户口语若需解释，可写：「一轮内脑执行（burst）」；**不要**单独引入 Sprint 产品概念。
- Scrum「两周 sprint」与本系统无关。

### 1.2 相近但不同

| 词 | 不是 |
|----|------|
| burst | 不是 KPI；不是日历；不是心跳 tick |
| AWAITING | 不是「整个 KPI 忙碌」；是该 burst 在等依赖 |
| advance / 推进 | 是调配（派 burst / ensure 日历 / sleep），不是一种新对象 |
| repair / bootstrap | 是本轮 work package **种类**，仍落成一次 burst |
| Skill / skill_md | **不是** Executable Workflow 的同义词；只是 EW 的一种 `WorkflowKind` |
| HarnessSpec / upgrade | **不是** Outer W15 `ew_revision` 提案；**不是** 进程 resume |
| explore burst | 可 DESIGN / 换路线；产出候选，**不保证**可重复执行 |
| execute burst | 必须 `workflowRef`；逐步 `expect`；默认禁止 redesign |

---

## 2. 调度与日历

| 权威词 | 含义 |
|--------|------|
| **due** | 承诺已到点、待 loop 兑现 |
| **ensure（日历）** | 幂等写入/确认某条 commitment（如 KPI 周期） |
| **calendar_due** | 日程触发 loop 的事件名 |
| **purpose** | commitment 类型：`kpi_increment` / `chat_appointment` / …（见 [`EMPLOYEE-CALENDAR.md`](./EMPLOYEE-CALENDAR.md)） |

到期「派 KPI 增量」= **派发一轮绑定该 KPI 的 burst**，不叫 sprint。

---

## 3. 代码遗留标识（改名非本轮义务）

以下 **标识符可暂留**，文档描述时译为 burst：

| 标识 | 文档应写作 |
|------|------------|
| `buildKpiSprintGoal` / `dispatchKpiSprint` | 遗留函数名；语义 = 构建/派发 KPI **burst** |
| `kpi_sprint_in_progress` | 已有 KPI 相关 burst 在途 |
| goal.md 标题 `# KPI burst` | 已与叙述对齐（旧版曾为 `# KPI sprint`） |

新代码/新日志 **禁止**再增加 `sprint` 公共名。

---

## 4. 修订

| 日期 | 说明 |
|------|------|
| 2026-07-22 | 初版：统一 burst，废弃文档中的 sprint 同义用法 |
| 2026-07-23 | 增补 Executable Workflow / BurstMode / WorkflowKind / promote（工作流）；明确 Skill ⊂ EW |

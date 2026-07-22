# 架构名词表（权威）

> **English:** Canonical vocabulary for Kuroneko outer/inner autonomy. **One concept → one term.** Prefer code-aligned names (`burst`, `KPI`, `commitment`) over informal synonyms (`sprint`).
>
> **适用范围**：`doc/structurizr/` 及外脑/内脑产品叙述。代码里遗留标识符（如 `buildKpiSprintGoal`、`kpi_sprint_in_progress`）见 §3，**文档叙述不得再发明同义新词**。

---

## 1. 核心对象（必须统一）

| 权威词 | 含义 | 禁止再用（同义混用） | 代码锚点 |
|--------|------|----------------------|----------|
| **KPI** | 长期目标身份；可挂多轮执行 | 「绩效目标」作另一套系统（已合并） | `KpiRecord` / `set_kpi` |
| **burst** | **一次**内脑执行：派发 → instance + workspace → 终态（DONE / AWAITING / ERROR / …） | **sprint**、KPI sprint、一轮 sprint、内脑 sprint | `instanceId`、`InnerBrainRegistry`、`set_goal`、`burstRunHistory` |
| **instance** | burst 的运行时身份（常与 workspace 1:1） | 与 burst 混称「任务」且不区分 KPI | `ib-…` |
| **workspace** | 该 burst 的磁盘工作区 | — | `task-ib-…` |
| **charter / 本轮章程** | 本发 burst 的窄目标文案（可验收） | 把整份 KPI Duty 当成本轮 goal | `goal.md`、窄 work package |
| **work package** | 有边界的本轮工作描述（expectedOutcome + 预算） | 「一小步 sprint」 | SelfWork / advance allocator |
| **commitment / 日历承诺** | 未来必须兑现的日程条目 | 「日历工具」若指另一套存储 | `employeeCalendar` / Scheduler task |
| **SelfWork** | 无 due 时，围绕 KPI 的自主提案 | 与 burst 本身混淆 | `SelfWorkPolicy` |
| **digitalEmployeeLoop** | 容量主循环：due 优先 → SelfWork → 唯一 `set_goal` | 「心跳派活」作主时钟 | `digital-employee-loop.ts` |

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

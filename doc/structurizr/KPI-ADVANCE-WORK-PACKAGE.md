# KPI「推进」：感知驱动的资源调配（ADL）

> **English:** **Advance is resource allocation**, not a new domain state-machine. The fix is to give the allocator **rich, machine-readable perception** of calendar and inner-brain resources, then apply simple dispatch rules. Complex Work-Package lease graphs are **not** the primary design. Complements [`DIGITAL-EMPLOYEE-AUTONOMY.md`](./DIGITAL-EMPLOYEE-AUTONOMY.md)、[`ENVIRONMENT-MODEL.md`](./ENVIRONMENT-MODEL.md)、[`OUTER-HEARTBEAT-OVERSIGHT.md`](./OUTER-HEARTBEAT-OVERSIGHT.md).
>
> **状态**：P0–P3 已落地。
>
> **修订立场（2026-07-22）**：上一版偏「WP + claim 租约」把问题做成代理层；**正确主线是感知面加厚 + 调配规则保持简单**。
>
> **实现落点**：`advance-perception` · `advance-allocator` · `advance-cursor-store` · `advance-metrics` · runtime/心跳/list-read 共用。

---

## 0. 正确问题陈述

「推进」环节要做的事只有一类：

> **在已知资源状态下，决定把容量用在哪里**——起内脑、兑现/写入日程、或休眠。

因此：

| 要做 | 不要做 |
|------|--------|
| 尽量完整地 **感知** 日程与内脑（及容量） | 再发明一套重型 WP 生命周期去「代替」感知 |
| 用感知结果做 **简单 if/优先级** 调配 | 用代理对象回避「看不清」 |
| 把已有 Dashboard/stall/liveness 信号接到调配读口 | 让对话 LLM / SelfWork 在盲区猜 |

重复整单、不写日历、长跑瞎猜——根因都是 **调配时看不见该看见的资源**，不是缺一个叫 Work Package 的中间名。

---

## 1. 推进 = 调配器（输入 / 输出）

```text
EnvironmentSnapshot（加厚）
  ├─ capacity（槽位 / LLM / 预算）     ← 已有
  ├─ calendar facet（日程状态）         ← 必须可被推进消费
  └─ innerBrain facet（内脑状态）       ← 必须可被推进消费
        │
        ▼
  advanceAllocator（简单规则）
        │
        ├─ honor due calendar → set_goal（窄包）
        ├─ ensure / skip calendar write
        ├─ spawn repair / bootstrap / increment（仅当感知允许）
        └─ sleep
```

**输出动作集合保持小**：`execute_due` | `set_goal` | `ensure_calendar` | `sleep` |（可选）`post_status`。  
不新增「推进状态机」作为产品概念。

---

## 2. 必须感知什么（本设计的硬核）

推进既然可能 **写日程** 或 **起内脑**，调配前就必须能回答下面问题——用 **结构化 facet / 工具字段**，禁止靠 LLM 臆测。

### 2.1 日程资源（Calendar facet）

| 感知项 | 用途 |
|--------|------|
| 该 `kpiId` 是否已有周期承诺（key / id） | 避免重复写入「每日」 |
| 承诺 status：`scheduled / due / running / missed / paused` | due 优先；missed 升级；running 勿再派同承诺 |
| `nextRunAt` / 是否未到期 | 未到期 → SelfWork **不要**用整单增量抢跑 |
| title / expectedOutcome / seedKind 摘要 | 调配时知道「到期要干什么」 |
| due 数量、最早 due | 容量与优先级 |

落点：强化已规划的 `calendarSensor`（DE §2.2）；`employeeCalendar.listByKpi(kpiId)` 对推进可读。

### 2.2 内脑资源（Inner-brain facet）

| 感知项 | 用途 |
|--------|------|
| 本 KPI 是否已有 `RUNNING` / `AWAITING` burst | 有则 **默认不再 set_goal**（同 KPI 单飞） |
| `liveness`：active / stuck / dead + `last_tick_at` / ticks | 活着 vs 卡死 vs 需 reap（对齐 HTTP enricher，**接入** list/read 工具与 snapshot） |
| `dyflow_mode`、async / ask_user pending | 等人 ≠ 空槽可乱填 |
| 最近 deliverables 计数 / 是否已 ingest | 避免「以为没产出」再开整单 |
| stall 摘要（若有）：cap / 空转 / long_run | 调配选 repair / 停派 / 上报，而不是再盲派 |
| 最近 burst 终态 + outcome 要点 | 决定 bootstrap 是否已做过、该不该增量 |

落点：扩展 `EnvironmentSnapshot` 的 inner 面，或推进专用 `collectAdvanceView(kpiId)`；**与** `list_inner_brains` / `read_inner_status` **同源**，消灭「Dashboard 有、调配无」的不对称。

### 2.3 已有容量感知（保持）

`hasAvailableCapacity` 照旧；推进 **不得**在无容量时硬起内脑（due 可保持 due）。

---

## 3. 简单调配规则（有感知之后）

规则应短、可测、可读。示例（权威意图，实现可微调阈值）：

```text
1. 无容量 → sleep（due 保留）
2. 该 KPI 有 RUNNING 且 liveness=active → sleep（或仅监督，不 set_goal）
3. 该 KPI 有 RUNNING 且 liveness=stuck|dead → 走监督/reap 路径，不新开并行整单
4. 有 due 且承诺属本 KPI → execute due（set_goal 用承诺上的窄 action）
5. 该 KPI 已有未到期周期日历 → SelfWork 禁止「增量/整单推进」该 KPI
6. 感知显示尚无基线产出且无在途 → 允许一次 bootstrap 窄 goal（非 Duty 全文）
7. 感知显示基线已有 + 无 due + 无在途 → 不抢跑；ensure 日历（幂等）后 sleep，等 due
8. 感知显示缺交付 / stall → 可选一次 repair 窄 goal
9. 否则 sleep
```

要点：

- **写日历**：只在感知「该 KPI 还没有对应周期承诺」时 `ensure`（幂等键），不是每次推进都写。  
- **起内脑**：只在感知「没有健康在途 + 有明确窄任务」时。  
- **整份 Duty 全文**：在有感知的前提下直接 **禁止** 作为默认 goal（一条规则即可，不必上 claim 状态机）。

---

## 4. 与「工作包」措辞的关系（降级）

| 保留 | 降级 / 不做主线 |
|------|-----------------|
| 派给内脑的 **goal 文本要短、可验收**（可称 work package 文案） | WP id / claimToken / fingerprint 租约大状态机作主设计 |
| cursor 类轻量记忆：`bootstrapDone` / `sinceAt`（可用 notes 或小 JSON） | 为防重派再叠一层代理生命周期 |

若实现需要防抖：优先用 **感知**（已有 RUNNING、已有日历、已有产物）+ loop 已有 single-flight；不够再加 **最小** 去重（例如「同 kpi 短窗不重复 set_goal」），而不是完整 lease 图。

---

## 5. 外脑对话 / SelfWork / 心跳 共用同一感知

| 消费者 | 用法 |
|--------|------|
| `digitalEmployeeLoop` / SelfWork | 调配输入 = snapshot facets |
| `list_inner_brains` / `read_inner_status` | 与 facet **同字段**（liveness、日历摘要可挂 KPI 视图） |
| heartbeat 质控 | 读同一面，禁止只靠 thin phase 猜 |
| 用户问「还在干吗」 | 答感知字段，不编故事 |
| 用户问「有没有定时日程」 | 答双轨：实时推进 ≠ 日历；**禁止**说「系统没有 cron」；见 DE §3.4 |

长程 1h+ 猜状态，与推进盲派，是 **同一感知缺口** 的两个症状。

**基线判定（cursor.bootstrapDone）**：历史中任一次 `deliverableCount>0` 的成功交付即算基线完成（含 exit=`DONE` **或** `AWAITING`——async 收尾仍可能已有产物）。仅要求 `DONE` 会导致日历永不 `ensure`。

---

## 6. 分期（按感知优先）

| 阶段 | 内容 |
|------|------|
| **P0** | Calendar facet + Inner facet 进 snapshot / 推进读口；list/read 对齐 liveness、本 KPI 在途、日历是否存在 | ✅ |
| **P1** | SelfWork / due 改吃 facet 的简单规则 §3；禁 Duty 全文默认；ensure 日历幂等 | ✅ |
| **P2** | stall 摘要进 facet；对话与心跳共用 | ✅ |
| **P3** | 可选轻量 cursor（sinceAt/bootstrapDone）；指标：盲派率、重复日历写入=0 | ✅ |

---

## 7. 不变量

1. 推进是 **调配**，主成本花在 **感知**，不花在新状态机。  
2. 可能写日历或起内脑 ⇒ 调配前必须能读 **日程状态 + 内脑状态**。  
3. 感知与外脑工具 / Dashboard **同源**，禁止双真相。  
4. 无容量、有健康在途、有未到期周期承诺 ⇒ 默认不起第二内脑。  
5. 日历写入幂等（一 KPI 一类周期一条）。

---

## 8. 测试地图

| 测项 | 断言 | 状态 |
|------|------|------|
| facet：有 RUNNING active | allocator 不 set_goal | ✅ `advance-allocator.test` |
| facet：已有周期日历未 due | 不整单增量、不重复 ensure | ✅ |
| facet：无日历无基线 | 允许一次 bootstrap + ensure 一条日历 | ✅ |
| facet：近窗 stall 且无在途 | 允许一次 repair；在途 stall 不并派 | ✅ |
| list_inner_brains 含 liveness | 与 snapshot 同源 `computeBurstLiveness` | ✅ 工具字段 |
| 心跳注入推进感知 | liveness + stall digest | ✅ |
| cursor sinceAt 写入增量 prompt | 幂等 sync + ensure 注入 | ✅ |
| 指标：盲派率 / 重复日历 create | `advance-metrics` | ✅ |

---

## 9. 修订

| 日期 | 说明 |
|------|------|
| 2026-07-22 | 初版误偏 WP/租约 |
| 2026-07-22 | ADV-6 日历幂等；§3b claim 链 |
| 2026-07-22 | **收敛**：主线改为感知驱动调配；WP 租约降级；明确日程+内脑 facet 为推进前置条件 |
| 2026-07-22 | **P0/P1 落地**：perception + narrow bootstrap + ensure 日历 + list/read liveness |
| 2026-07-22 | **P2**：stall 进 facet；`kpiIdsNeedingRepair` → repair 窄 goal；心跳/list/read 共用 |
| 2026-07-22 | **P3**：`advance-cursors.json`（bootstrapDone/sinceAt）+ `advance-metrics`（盲派率/重复日历） |
| 2026-07-22 | 外脑 prompt 双轨（DE §3.4）；`bootstrapDone` 认 AWAITING+产物 |

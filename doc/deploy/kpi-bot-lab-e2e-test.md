# Bot1/Bot2 — KPI 闭环端到端观测测试

> 与 [`bot1-bot2-webchat-lab.md`](./bot1-bot2-webchat-lab.md)、[`../structurizr/KPI-CLOSED-LOOP.md`](../structurizr/KPI-CLOSED-LOOP.md) 对齐。  
> **目的**：在隔离实验对上注入一条**可控、可验收**的 KPI，在 15–45 分钟内观测外脑 KPI 行为是否符合 ADL（不串扰、能续跑、空转有上限）。

---

## 0. 测试分层

| 层 | 命令 / 入口 | 时长 | 验证什么 |
|----|-------------|------|----------|
| **L0 单元** | `npm run test:unit -w @utlra/server -- --run src/outer/kpi-*.test.ts` | 秒级 | 规划上下文过滤、`suggestKpiAction`、burst hook |
| **L1 集成** | `kpi-lifecycle.integration.test.ts` | 秒级 | 模拟 burst 退出 → achieved / outcome 评估 |
| **L2 Bot Lab E2E**（本文） | bot1/bot2 + IM 或 HTTP | 15–45 min | 真实 LLM、autonomy、自动续跑、日志与落盘 |

L2 在合并 KPI 修复后**必须**跑一轮，L0/L1 不能替代。

---

## 1. 前置条件

1. `deploy/agent/env/bot1.env`（或 bot2）已填：`LOCALMODULE_*`、`WEBCHAT_AGENT_SECRET`、`MEM9`、`DRIVE9`。
2. 代码已包含 KPI 上下文隔离修复（`kpi-goal-context` / `kpi-progress`）。
3. 建议 **干净 data**：`npm run dev:agent:bot1:fresh` 或 `-SkipProvision` 仅清 `data-bot1`。
4. 启动：`npm run dev:agent:bot1` → 日志路径见控制台（通常 `scripts/local-dashboard/.logs/agent-bot1-local.log`）。

```powershell
curl.exe -fsS http://127.0.0.1:8796/api/health
```

---

## 2. 推荐测试 KPI（可验收、低副作用）

在 webchat-lab **@Bot1** 发（或走 §3 HTTP + 外脑一轮）：

```text
@Bot1 请为 KPI 闭环测试注册一个 KPI，并立刻派第一发内脑：

【KPI 描述】E2E-KPI-TEST：在 workspace 根目录创建文件 kpi-e2e-proof.txt，
内容恰好一行：KPI_E2E_OK_<ISO日期>（例如 KPI_E2E_OK_2026-06-02）。
禁止调研、禁止读群聊、禁止帮其他 agent 做事。
完成后 register_deliverable 登记该文件，并汇报 kpi_id。

若已有 active 的 E2E-KPI-TEST，先 abandon 再重建。
```

**通过标准（硬）**：

| # | 观测点 | 预期 |
|---|--------|------|
| A | `data-bot1/kpi-registry.json` | 1 条 active，`description` 含 `E2E-KPI-TEST` |
| B | `inner-brain-registry.json` | 同 KPI 仅 **一个** canonical `instanceId`；`kpiId` 一致 |
| C | `workspaces/task-ib-*/kpi-e2e-proof.txt` | 存在且含 `KPI_E2E_OK_` |
| D | `.run/pi-mono/deliverables.json` | 含该文件路径 |
| E | 日志 | 出现 `kpi=` / `auto continue` / `burst done`；**不应**长期刷屏 `casual_chat_defer_to_kpi` 且无 `kpi_inner_goal` |
| F | 规划污染 | `kpi-e2e-proof` / 其他无 kpi 任务 **不出现在** autonomy KPI 规划上下文（见 §5 脚本） |

**软标准（续跑）**：

| # | 观测点 | 预期 |
|---|--------|------|
| G | 首 burst `DONE` 且 deliverables=0 | `consecutiveIdleBursts` 增加；outcome 换 charter + `UTLRA_KPI_AUTO_NEXT_BURST` 续跑 |
| H | 首 burst 已成功且 post_complete | 自动 `achieved` 或外脑 `achieve_kpi`；autonomy 不再派同主题 `kpi_inner_goal` |

---

## 3. 注入方式（二选一）

### 3a. IM（推荐，测全链路）

1. 打开 https://kuroneko.chat/webchat-lab/
2. @Bot1 发送 §2 文案。
3. 确认外脑回复含 `kpi_id=` 且 `set_goal` 已派发。

### 3b. HTTP（仅注册 KPI，不自动派 burst）

```powershell
$body = @{
  description = 'E2E-KPI-TEST: 创建 kpi-e2e-proof.txt 一行 KPI_E2E_OK_<date>'
  createdBy   = 'human:e2e'
  notes       = 'bot-lab e2e'
} | ConvertTo-Json -Compress

Invoke-RestMethod -Uri 'http://127.0.0.1:8796/api/kpis' -Method Post -Body $body -ContentType 'application/json'
```

随后仍需 IM 或 Dashboard 触发外脑 `set_goal(kpi_id=...)`（`POST /api/kpis` **不**派 burst，见 `index.ts` 注释）。

---

## 4. 观测时间线（建议 45 min）

| 时刻 | 动作 |
|------|------|
| T+0 | 注入 KPI；记录 `kpi_id` |
| T+2 min | `observe-kpi-bot.ps1 -Agent bot1 -KpiId <id> -Once` |
| T+10 min | 再看 registry + workspace 是否已有 proof 文件 |
| T+20 min | 若 burst 已 DONE：查 `auto continue` / `idleStreak` / 是否误 `follow_up` |
| T+45 min | 收尾：`achieve` 或 `abandon`；`dev:agent:bot1:stop` |

周期性观测：

```powershell
powershell -File scripts/kuroneko/observe-kpi-bot.ps1 -Agent bot1 -KpiId kpi-xxxxx -IntervalSec 120 -DurationMin 45
```

---

## 5. 日志与落盘检查清单

**日志**（`Select-String`）：

```powershell
$log = 'D:\kuroneko\scripts\local-dashboard\.logs\agent-bot1-local.log'
Select-String -Path $log -Pattern '\[utlra\]\[(kpi|autonomy|outer-tools)\]' | Select-Object -Last 40
```

| 模式 | 含义 |
|------|------|
| `dispatched task=kpi_inner_goal` | autonomy 在推 KPI |
| `skip kpi_inner_goal:` | 记录 reason（`kpi_burst_in_flight` / `stuck_retry` / cooldown） |
| `auto continue on` | 自动续跑触发 |
| `burst done.*deliverables=` | burst 退出 |
| `casual_chat_defer_to_kpi` | 仅当 `kpi_inner_goal` 在 cooldown 时常见，不应 30min 仅此项 |

**空转相关**：

```powershell
$stall = 'D:\kuroneko\packages\server\data-bot1\stall-alerts\index.jsonl'
if (Test-Path $stall) { Get-Content $stall -Tail 5 }
```

**内脑 worker**：

```powershell
Get-ChildItem 'D:\kuroneko\packages\server\data-bot1\workspaces\task-ib-*\.run\inner-worker-status.json' -Recurse -ErrorAction SilentlyContinue |
  ForEach-Object { $_.FullName; Get-Content $_ -Raw }
```

---

## 6. 失败分诊

| 现象 | 可能原因 | 下一步 |
|------|----------|--------|
| 有 KPI 无内脑 | 外脑未 `set_goal` / LLM 失败 | 看日志 `set_goal_failed`；手动 @ 再派 |
| 内脑 RUNNING 很久无文件 | RUN 失败循环 / LLM 慢 | 查 `dyflow-state.json`、`stall-alerts` |
| `idleStreak` 涨但不续跑 | 旧 AWAITING 误判 `follow_up`（已修）或 `AUTO_NEXT_BURST=0` | 确认 env；拉最新代码 |
| 规划 goal 跑题（群聊/他人任务） | 规划上下文串扰（已修） | 对照 `buildKpiGoalPlannerContext` 是否仅本 KPI 在途 |
| 达成不收尾 | `is_post_complete` false 或无 deliverable | `view_kpi` / `read_inner_status` |

---

## 7. 与 Cursor Agent 协作

可由 Agent 执行：

1. `npm run dev:agent:bot1`（需用户已配置 env）
2. `POST /api/kpis` 或提示用户在 lab @Bot1
3. 每 5–10 min 跑 `observe-kpi-bot.ps1`，对照 §2 表格汇报
4. 结束后 `abandon` KPI + stop agent

**当前限制**：本机未起 bot1/bot2 时 Agent 只能准备文档与脚本，不能代替完成 L2。

---

## 8. 内脑「空转」说明（2026-06 现状）

| 机制 | 行为 |
|------|------|
| **DyFlow DESIGN 空转** | 连续 3 次 Designer `empty` → `mode=DONE`，日志 `design.giveup` |
| **Pi auto 循环** | `hadWork=false`（含 DONE/AWAITING）→ **立即** `stoppedBy=idle` 退出，不空烧满 500 tick |
| **RUN 失败循环** | 每次 RUN 后回 DESIGN；可能多轮直到 `max_ticks`，由 **stall-alerts** 落盘 |
| **KPI meta 反思** | `UTLRA_KPI_REFLEXION_MAX_TICKS`（默认 20）上限 |

因此：**不会像旧 Pi 那样单 burst 无脑跑满 500 tick**；仍可能出现「DESIGN↔RUN 多轮无 deliverable」——看 `stall-alerts/` 与 `deliverables.json`，不是外脑 KPI 日志里的 `idle no dispatch`。

# 真实任务运行观测（Task Run Observability）

> **English:** Large tasks run in **real environments** (real LLM, real workspaces). Observability is **post-hoc analysis** on persisted journals—not FakeLLM micro-benchmarks. Two calibration tasks: **novel writing** and **Pokemon Showdown KPI**.

与 [`LLM-USAGE-JOURNAL.md`](./LLM-USAGE-JOURNAL.md)、[`ENVIRONMENT-MODEL.md`](./ENVIRONMENT-MODEL.md) 互补：本文定义 **一次「大任务跑完」** 该采什么、存哪、怎么对比调优前后。

---

## 1. 原则

| 原则 | 说明 |
|------|------|
| **真实环境** | 真实 provider、真实内脑子进程、真实 `DATA_ROOT` |
| **固定任务用自然语言即可** | 标定用例：`小说创作`（长文、多章节 deliverable）；`宝可梦对战 KPI`（长链、多 shell/burst、环境依赖） |
| **Run = 分析单位** | 一次「从开始派活到用户/外脑宣告阶段结束」= 一个 **run**，可跨多个 burst / 多个 KPI |
| **调优判据** | 同一任务描述下：**总 token↓ 或 outcome↑**（或两者）；不能只看 token |
| **已有数据优先** | 不重复造轮；在现有 journal 上 **加 run 标签 + 汇总脚本 + 报告模板** |

FakeLLM 场景基准（[`FRAMEWORK-BENCHMARK.md`](./FRAMEWORK-BENCHMARK.md)）仅作 **CI 机制回归**，**不**替代本文。

---

## 2. 两个标定任务（各一句话）

| runKind | 描述 | 观测重点 |
|---------|------|----------|
| **`novel`** | 外脑/ KPI 驱动下完成一部长篇小说创作（多章节、多 deliverable、长 AWAITING 少）。 | token / deliverable、章节产出率、外脑 vs 内脑 token 比、单 burst 是否过短 |
| **`pokemon`** | 在本机或指定环境完成 Pokemon Showdown 注册/登录/对战闭环（含 Playwright 或 WS，多 burst、多 ERROR 重试）。 | token / burst 数、shell 工具占比、meta 诊断 burst、是否出现 rated 实战、僵尸 RUNNING |

---

## 3. 数据层（已存在 → 需补）

### 3.1 已落盘（按 agent `DATA_ROOT`）

| 路径 | 内容 | 观测用途 |
|------|------|----------|
| `usage/llm-usage.jsonl` | 每次 LLM 调用 token、source、model、**instanceId** | **成本主表** |
| `inner-brain-registry.json` | burst 状态、ticks、deliverableCount、kpiId | **并行度、失败率、产出**（终态可被 [`INNER-WORKSPACE-RETENTION.md`](./INNER-WORKSPACE-RETENTION.md) 淘汰，勿假设永久） |
| `kpi-registry.json` | bursts[]、burstRunHistory、status | **战略漂移、outcome 是否重复失败** |
| `autonomy/action-log.jsonl` | 心跳 dispatch / skip 原因 | **外脑是否在空转派活** |
| `performance/journal.jsonl` | 绩效目标（若有） | 长期目标对齐 |
| `environment/events.jsonl` | 环境事件（P1 起） | 过载、token 速率趋势 |
| `workspaces/task-*/.run/pi-mono/logs/*.jsonl` | DyFlow tick（designer/base-node start·done） | FSM 阶段 |
| `inner/tool-logs/<workspaceId>/*.jsonl` | baseNode/Designer **逐工具** call·result（DyFlow） | **工具结构、参数、耗时** |
| `stall-alerts/index.jsonl` + `stall-alerts/<ib-id>/*.json` | **空转即时告警包**（[`INNER-BURST-STALL-ALERT.md`](./INNER-BURST-STALL-ALERT.md)） | Cursor 定位、Dashboard「空转」Tab |
| `workspaces/task-*/.run/pi-mono/deliverables.json` | 交付物列表 | **outcome 代理指标** |
| `workspaces/task-*/.brain/*` | goal、milestones、knowledge | 计划 vs 执行 |
| `outer/tool-logs/<agentSid>/*.jsonl` | 外脑 tool 审计 | set_goal 频率、meta 任务 |
| `context/chat/threads.json` | IM 线程 | 用户可见叙事 vs 后台 |

Dashboard：**用量** Tab → `GET /api/usage/summary`（[`LLM-USAGE-JOURNAL.md`](./LLM-USAGE-JOURNAL.md)）。

### 3.2 需补（P0 观测闭环）

| 模块 ID | 职责 | 实现方向 |
|---------|------|----------|
| **taskRunRegistry** | 一次大任务的 `runId`、runKind、起止时间、关联 kpiId/instance 列表 | `data/runs/<runId>.json` 或 `runs/registry.json` |
| **taskRunExporter** | run 结束一键打包（registry + usage 切片 + 关键 workspace + logs） | 扩展 `exports/*` 模式 |
| **taskRunAnalyzer** | 读 export 或 live DATA_ROOT → **RunReport JSON + Markdown** | `scripts/observe/analyze-run.mjs` |
| **taskRunCompare** | 两次 RunReport diff（调优前/后） | 同脚本 `--baseline run-a --candidate run-b` |

**run 边界（人工 + 半自动）**：

1. **开始**：创建 run 记录（Dashboard 按钮或 `POST /api/runs`）→ 写 `runs/active.json` `{ runId, runKind, startedAt }`  
2. **进行中**：现有 journal 自动写；可选 env `UTLRA_ACTIVE_RUN_ID` 注入到 `llm-usage` / autonomy log（P1）  
3. **结束**：标记 `finishedAt`，触发 export + analyze

---

## 4. RunReport 指标（调优尺子）

一次 run 汇总为 **RunReport**（JSON 权威，Markdown 人类读）。

### 4.1 成本（必看）

| 指标 | 算法 | 调优希望 |
|------|------|----------|
| `totalTokens` | run 时间窗内 `llm-usage.jsonl` Σ totalTokens | ↓ |
| `tokensBySource` | 分 outer_conversation / inner_pi_mono / autonomy … | 定位「谁在烧」 |
| `tokensByInstance` | 按 instanceId top-N | 找到「黑洞 burst」 |
| `promptToCompletionRatio` | Σ prompt / Σ completion | Executor 膨胀信号 |
| `tokensPerDeliverable` | totalTokens / max(deliverableCount, 1) | **效率主 KPI** |
| `costPerHour` | totalTokens / wallHours | 长跑对比 |

### 4.2 执行结构（必看）

| 指标 | 算法 | 调优希望 |
|------|------|----------|
| `burstCount` | registry 中 run 窗内新 instance 数 | ↓（同 outcome） |
| `burstByStatus` | RUNNING/DONE/ERROR/STOPPED/AWAITING | ERROR↓ |
| `pivotCharterRate` | outcome 换向 charter 占比 | 适度即可 |
| `avgTicksPerBurst` | Σ ticks / burstCount | 异常高/低都查 |
| `parallelRunningMax` | 同窗 max 同时 RUNNING | 并行浪费 |
| `toolMix` | pi-mono logs：shell_exec / read_file / register_deliverable 占比 | shell↓ deliverable↑ |
| `topRepeatedReads` | read_file 路径 top-10 | 复用差信号 |
| `executorRoundP95` | 单 burst logs 内 executor llm.call round 分位 | ↓ |

### 4.3 战略 / 复用（必看）

| 指标 | 算法 | 调优希望 |
|------|------|----------|
| `outcomeEvalCount` | burstRunHistory.outcomeEvaluation 增量 | 每 burst 应有 |
| `hardFailureRepeatRate` | 新 burst 是否再犯 outcome failureReasons 主题 | ↓ |
| `kpiSwitchCount` | abandoned + new kpi | 稳定任务应少 |
| `idleDispatchSkips` | action-log `kpi_sprint_in_progress` 等 | 理解心跳 |

### 4.4 Outcome（任务相关，必看但阈值不同）

**novel**

| 指标 | 说明 |
|------|------|
| `deliverableCount` | register_deliverable 累计 |
| `chapterFiles` | workspace 下章节 md/字数（analyzer 扫盘） |
| `userVisibleComplete` | 外脑是否宣告「完稿/可读」 |

**pokemon**

| 指标 | 说明 |
|------|------|
| `battleLogExists` | `battle_run.log` 等 |
| `ratedOuAttempt` | log 含 `/search gen9ou` 且非 randombattle URL |
| `battleOutcomeLogged` | WIN/LOSS 或完整回合数 |
| `screenshotArtifacts` | png 数量 |

**调优合格**：在 **outcome 不低于基线 run** 的前提下，`tokensPerDeliverable` 或 `totalTokens` 显著下降。

---

## 5. 工作流（操作手册）

### 5.1 跑前

```text
1. 选定 agent（如 yuanbao / shiro）与 DATA_ROOT
2. 创建 run：runKind=novel|pokemon，note=「调优前 baseline v0」
3. （可选）清空或归档旧 ERROR burst，避免噪声
4. 记录 git commit、env 摘要进 run meta
```

### 5.2 跑中

- Dashboard → **用量**（实时 token）  
- Dashboard → **内脑**（RUNNING/ERROR/liveness）  
- 不要仅看外脑 chat；**必须**看 registry + usage

### 5.3 跑后

```text
1. 结束 run（写 finishedAt）
2. taskRunExporter → exports/run-<runId>-<ts>/（P1，可选）
3. taskRunAnalyzer → RunReport.json + RUN-SUMMARY.md
4. 归档到 **仓库外** `<repo>/../kuroneko-observations/runs/<runKind>/<runId>/`
   或 `KURONEKO_OBSERVATIONS_DIR`；勿依赖 git 分支内路径
```

### 5.4 调优对比

```text
baseline run A  （框架/version v0）
candidate run B（改 Executor / burst 策略后，同一任务描述）
taskRunCompare A B → DELTA.md
```

关注：**ΔtotalTokens、ΔtokensPerDeliverable、ΔburstCount、outcome 列是否退化**。

---

## 6. Export 包结构（taskRunExporter 目标）

```text
exports/run-<runId>/
  README.txt              # run meta、git、env、任务一句话
  run-meta.json           # taskRunRegistry 快照
  usage/llm-usage.jsonl   # 时间窗切片
  inner-brain-registry.json
  kpi-registry.json
  autonomy/action-log.jsonl
  report/
    RunReport.json        # analyzer 输出
    RUN-SUMMARY.md
  workspaces/             # 可选：仅本 run 关联 task-*  symlink 或 copy
  agent-process.log       # 若有
```

与现有 `exports/gin-log-dump-*` 对齐，**加 run 边界与 report**。

---

## 7. ADL 组件（规划）

| 模块 ID | 路径 | 状态 |
|---------|------|------|
| taskRunRegistry | `outer/task-run-registry.ts` | ⏳ |
| taskRunExporter | `scripts/observe/export-run.mjs` | ⏳ |
| taskRunAnalyzer | `scripts/observe/analyze-run.mjs` | ✅ P0（读 live DATA_ROOT + 手填时间窗） |
| taskRunCompare | `scripts/observe/compare-runs.mjs` | ✅ P0 |
| runsApi | `index.ts` `GET/POST /api/runs` | ⏳ 可选 |

**落盘根目录**（默认不在 git 仓库内）：

| 优先级 | 路径 |
|--------|------|
| 1 | `KURONEKO_OBSERVATIONS_DIR` |
| 2 | `<repo>/../kuroneko-observations/` |
| 3 | `<repo>/.observations/`（`.gitignore`） |

CLI 说明：[`scripts/observe/README.md`](../../scripts/observe/README.md)

视图：挂 **`agentServer`** L3，边：`llmUsageJournal` → `taskRunAnalyzer`，`innerBrainRegistry` → `taskRunAnalyzer`。

---

## 8. 与 Dashboard 的关系

**信息架构（2026-07-25）**：主 Tab 只保留当前运维关键面；旧调试面收进「高级」。

| 主 Tab | 内容 |
|--------|------|
| **内脑 Burst**（默认） | 列表（状态/引擎/KPI/目标）+ 钻取 **执行 graph** |
| Workflows | 已晋升 EW 只读 |
| 用量 | token / LLM usage |
| 空转 | stall-alerts |
| 日志 | timeline |
| 记忆块 | Memory Blocks（keychain 等） |

| 高级（折叠） | 说明 |
|--------------|------|
| 数据层（文件） | workspace 文件树 / artifacts（旧） |
| 外脑快照 | workspace 级 outer 状态（旧） |
| 参与 Lab | participation 调试（旧） |

已移除出主面：daily-log/tasks.md 编辑、Pi-mono 单步/Auto/reset、节点触顶旧命名、「数据层」默认首页。

**Burst 执行 graph（P0 UI）**：`GET /api/inner/:ws/brain-inspector` → `dyflow.dag.{nodes,edges,impliedEdges}` + 每节点 `status` + 可选 `workflowRun`。

---

## 9. 实施顺序

| 阶段 | 交付 | 验证 |
|------|------|------|
| **P0** | `analyze-run.mjs` 读 live DATA_ROOT + 手填 run 起止 → RunReport | ✅ 已实现；落盘 `../kuroneko-observations` |
| **P0** | `compare-runs.mjs` | ✅ 已实现 |
| **P1** | `export-run.mjs` + README 模板 | 一键打包 |
| **P1** | `taskRunRegistry` + active run 标记 | usage 可挂 runId |
| **P2** | Dashboard Runs 面板 | 操作闭环 |
| **P2** | novel 跑一轮 baseline run 存档 | 第二个标定轴 |

---

## 10. 修订

| 日期 | 说明 |
|------|------|
| 2026-06-02 | 初版：真实大任务观测；novel + pokemon 标定；RunReport 指标；Exporter/Analyzer 规划 |
| 2026-06-02 | P0：`scripts/observe/` analyzer + compare；观测落盘默认仓库外 `kuroneko-observations` |
| 2026-07-24 | Dashboard 内脑：burst 执行 graph（DAG edges + node status + EW workflow_run） |
| 2026-07-25 | Dashboard 信息架构：主 Tab 只留 Burst/EW/用量/空转/日志/记忆块；旧面进高级 |

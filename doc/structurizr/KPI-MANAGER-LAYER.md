# KPI 管理器（ADL 权威）

> **English:** After **environment sensing**, a single **KPI Manager** owns all KPI lifecycle: registry, multi-burst parallelism, burst hygiene, AWAITING review, and spawn/stop/restart decisions. **Strategy Planner is removed.** Physical spawn remains `set_goal` → `innerSpawner`.

> 取代：[`KPI-ADVANCEMENT.md`](./KPI-ADVANCEMENT.md) 中的 leaf/首拆/单 burst 复用语义；[`STRATEGY-PLANNING-LAYER.md`](./STRATEGY-PLANNING-LAYER.md)（删除）；[`RESOURCE-AWARENESS-AUTONOMY.md`](./RESOURCE-AWARENESS-AUTONOMY.md) 中 dispatcher 选 KPI 的独立层。

> 与 `workspace.dsl` 视图 **`10b-L3-Outer-KPI`**、**`12-L3-Outer-Environment`** 同步。

---

## 1. 三层外脑（心跳 tick）

```mermaid
flowchart TB
  ENV[环境感知 environmentModel]
  CAP[kpiSpawnCapacity]
  KPI[KPI 管理器 kpiManager]
  ADV[kpiAdvancer]
  EXEC[物理执行 set_goal / innerSpawner]

  ENV -->|"EnvironmentSnapshot.facets"| CAP
  ENV -->|"EnvironmentSnapshot + verdict idle?"| KPI
  KPI --> CAP
  KPI --> ADV
  ADV --> CAP
  KPI -->|"spawn / stop / restart burst"| EXEC
  ADV --> EXEC
  IM[IM / HTTP 入站] --> ADV
  OPS[Ops advance_kpi] --> ADV
```

| 层 | 模块 | 职责 | 不做 |
|----|------|------|------|
| **L1 环境感知** | `environmentModel` | sensor + journal + policy + hardGates | 不选 KPI、不派 burst |
| **L2 KPI 管理器** | `kpiManager` | KPI 真相 + burst 编排 + 僵尸清理 + AWAITING 审查 | 不直接 fork 子进程（调 `set_goal`） |
| **L3 物理执行** | `outerToolExecutor.set_goal` | workspace 创建、peer 挂载、spawn worker | 不做 KPI 策略 |

**删除：** `strategyPlanner`、`strategyStore`（宏观 REFLECT+DESIGN / focusOrder）。KPI 优先级由 KPI 管理器内部规则 + 环境资源决定。

---

## 2. KPI 数据模型（简化）

### 2.1 取消子 KPI

- **不再** `decomposeParentKpiIfNeeded` / `isLeaf` / 父节点首拆。
- 每个 `KpiRecord` 即一个可执行 KPI（扁平或保留 `parentKpiId` 仅作分组展示，**不参与调度**）。
- 调度单位：**KPI id**，不是 leaf。

### 2.2 多 burst / 无 canonical 限制

| 旧语义 | 新语义 |
|--------|--------|
| 每 leaf KPI ≤ 1 canonical `instanceId` | 每 KPI **可有多条** active burst（并行 sprint） |
| `findCanonicalBurstForKpi` 强制复用 workspace | **默认每次新 burst 新 workspace**；续跑仅 `changeWatcher` / 显式 restart |
| `set_goal` 禁止同 KPI 并行 | **允许**在资源许可时同 KPI 多 burst |
| `KpiRecord.bursts[]` length ≤ 1 per leaf | `bursts[]` = 该 KPI 关联的全部 instanceId（含并行） |

### 2.3 调度：心跳即时派（无 cadence）

- **删除** `kpi-cadence.ts` / `isCadenceDue` / `nextDueAt` 调度路径（2026-06-07）。
- **续派时机**：idle 心跳 + `evaluateKpiAdvanceEligibility`（无 RUNNING / 非 ask_user / 未 achieved / 有 spawn 槽）→ 立即 `advanceKpi`。
- **定时/延迟**：由内脑 burst 内 `wait_timer` → `AWAITING` → `changeWatcher` 唤醒**同一 instance**；外脑不在 KPI 层再挂 cron/interval。
- **节流**：`kpi_inner_goal.cooldownMs = 0`；天然上限 = 心跳间隔 + 环境 hardGates（`maxRunningInnerBrains` 等）。

### 2.4 burst 互访（解除隔离）

- 同 KPI 下所有 burst workspace **默认互相可读**（`collectPeerWorkspaceIds` 按 `kpiId` 聚合全部 sibling）。
- **取消**「仅 handoff 摘要、禁止读正文」的强隔离；peer 工具可读 sibling `.brain` / 产出目录（仍受 workDir guard，禁止写 sibling）。
- spawn / restart 时刷新 peer 列表，使新 burst 可见已有 burst。

---

## 3. KPI 管理器职责

**路径（规划）：** `packages/server/src/outer/kpi/kpi-manager.ts`（吸收 `kpi-advancer`、`stale-burst-reaper`、`kpi-dispatch-guard` 编排逻辑）

**默认原则：** active KPI **持续运行**；心跳 tick 与环境 verdict 为 idle 时，KPI 管理器扫描所有 active KPI 及其 burst，决定 spawn / stop / retarget。

### 3.1 决策规则（P0）

| # | 条件 | 动作 |
|---|------|------|
| **R1** | burst 终态（DONE/ERROR 等）且 KPI 未 `achieved` | 环境 idle + 有槽 → **立即**新开 burst（无 cadence 层） |
| **R2** | 有 burst `RUNNING`，环境仍有槽位，且存在**可并行的新方向**（不同 charter / 子目标） | **新开 burst**（同 KPI 多 instance） |
| **R3** | burst `AWAITING` | 审查 awaiting 原因（timer / ask_user / dyflow DESIGN 空转 …）；**不合理** → stop + 改 goal 重开，或 ABORTED 归档 |
| **R4** | `ask_user` 超时无响应 | stop 或 ABORTED → 换方案 burst（不无限等人类） |
| **R5** | 僵尸 burst（长期 AWAITING/RUNNING 无进展） | 合并原 `staleBurstReaper`：`ABORTED` + archive + action-log |
| **R6** | 环境 busy（hardGates，读 `EnvironmentSnapshot.facets`） | 不 spawn；可继续 R3/R5 清理 |
| **R7** | 同 KPI 连续 burst 终态为 `ERROR`/失败 ≥ `maxConsecutiveFailures`（默认 3，可 policy 配） | **熔断**：KPI → `paused` + IM 通知人类原因；**停止心跳续派**，恢复需人工/Ops `advance_kpi` |

**R7 失败熔断（消除 503 风暴 / 模糊目标无限续派）— ✅ 2026-06-23 实现：**

- 计数源：`countConsecutiveBurstFailures(kpi, registry)` —— 该 KPI 的 burst 按 `startedAt` 倒序，末尾连续 `ERROR`/`ABORTED` 计数；`RUNNING`/`BLOCKED` 跳过不计不打断；遇 `DONE`/`AWAITING`/`STOPPED` 即清零。（用 innerBrainRegistry burst 状态，不依赖可能为空的 `burstRunHistory`。）
- 触发（`tripFailureCircuitBreakers`，心跳每 tick 续派前执行）：写 `kpi.status='paused'` + `kpi.pauseReason`，IM 通知（「⚠️ KPI「…」连续 N 次失败，已自动暂停。最近错误：…。回复『继续 <kpiId>』可重试」）+ `action-log`（reason=`kpi_failure_circuit`）。
- 双重保险：`evaluateKpiAdvanceEligibility({ maxConsecutiveFailures })` 在无在跑 burst 时返回 `kpi_failure_circuit`；paused KPI 又因 `status!=='active'` 返回 `not_active`。恢复由人工/Ops `resume`（清空 `pauseReason`）。
- 阈值：`DEFAULT_MAX_CONSECUTIVE_FAILURES = 3`，可经 `KpiManagerDeps.maxConsecutiveFailures` 覆盖。
- 与 R3/R5 区别：R3/R5 处理**单 burst**异常态（AWAITING/僵尸）；R7 处理**KPI 级**重复失败。
- 落点：`outer/kpi/kpi-failure-circuit.ts`；测试 `kpi-failure-circuit.test.ts` + `kpi-burst-state.test.ts`（eligibility gate）。

**delivery / 一次性语义（与 [`IM-INBOUND-INTENT-ROUTING.md`](./IM-INBOUND-INTENT-ROUTING.md) P4 对齐）：**

- **IM 路径不再铸 `delivery` KPI**；聊天触发的一次性任务走 `adHocBurstAllocator`（跑完归档，天然只跑一次，不进 KPI 续派）。
- 若历史/Ops 仍存在 `kind:'delivery'` KPI：首个 burst 终态（DONE）即由 `kpiCompletionJudge` 判 `achieved`，**不 R1 续派**；失败则受 R7 熔断约束，不无限重试。

**R3 合理性（deterministic P0，LLM P1）：**

- timer：`execute_at` 已过期 > grace → 可 preempt（现有 advancer preempt 逻辑迁入）
- ask_user：超过 `maxAwaitingMs` / 无 IM 回复 → R4
- dyflow `DESIGN` 空转 streak / `AWAITING` 无 pending → 不合理，重开
- `wait_timer` 用于 sprint 内短等待；**禁止**长睡代替外脑续派

### 3.2 与 KPI Completion Judge 边界

- **kpiManager**：在途 burst 编排、spawn/stop。
- **kpiCompletionJudge**：KPI 是否 `achieved` / `abandoned`（心跳 sweep，读 deliverable + 描述）。

---

## 4. 心跳 tick 顺序（修订）

```
1. environmentModel.collect → verdict
2. kpiManager.tick(environment, registry, kpiRegistry)   ← 含 reaper + advance + awaiting review
3. kpiCompletionJudge.sweep（可选同 tick）
4. changeWatcher（AWAITING timer 唤醒，非新 KPI sprint）
5. （可选）legacy heartbeat LLM — 禁止 set_goal(kpi_id)；KPI 仅 kpiManager
```

**删除 tick 内：** `runStrategyPhase` / `strategyPlanner` / 原 `autonomyTaskDispatcher` KPI 选路（合并进 `kpiManager.tick`）。

**保留：** `casualChatDispatcher`（`dispatchCasualChat`）— 仅 idle proactive IM 闲聊。

---

## 5. 物理 spawn 契约（不变）

- 唯一 spawn API：`executeOuterTool('set_goal', { goal, kpi_id?, allowKpiSetGoal: true })`（KPI 路径由 kpiManager 调用）。
- IM ad-hoc：无 `kpi_id` 的一次性 burst。
- AWAITING 唤醒：`changeWatcher` → `spawnAndAttachWorker`（同 instance，非 R1 新 sprint）。

### 5.1 charter 写入纪律（✅ 2026-06-23 修复嵌套膨胀）

- `buildKpiSprintGoal(kpi)` 渲染模板：`# KPI sprint … ## 本轮章程\n{charter || description} …`。
- **`dispatchKpiSprint` 派发后只更新 `lastBurstAt`，禁止把渲染后的 `goal` 写回 `kpi.charter`**。  
  旧 bug（`kpi-advancer.ts` `charter: kpi.charter ?? goal.slice(0,500)`）会让下轮 `buildKpiSprintGoal` 把整段模板再包一层 → `goal.md` 多重嵌套（`## 本轮章程\n# KPI sprint…## 本轮章程…`）。
- `charter` 只允许由「干净的下轮章程」写入：Ops `advance_kpi(charter)`、`kpi-api-dispatch`、`outcomeEvaluator.suggestedRetryCharter`。
- 回归测试：`kpi-advancer.test.ts`「多轮 dispatch 不把渲染 goal 写回 charter」。

---

## 6. DyFlow 与 registry 状态

DyFlow FSM（`dyflow-state.json`）：`DESIGN | RUN | ATTRIBUTE | AWAITING | DONE | ERROR | STOPPED`。

**无 legacy `DECOMPOSE` / planning 相位。**

| DyFlow mode | Registry 期望（worker 退出后） |
|-------------|-------------------------------|
| `AWAITING` + pendings | `AWAITING` |
| `DONE` | `DONE` |
| `ERROR` | `ERROR` |
| `DESIGN/RUN/ATTRIBUTE`（worker 运行中） | `RUNNING` |

**外脑读状态：** `buildBrainAsyncSnapshot` 必须读 `dyflow-state.json`（不能只读 `controller-state.json`），否则 KPI 管理器误判 AWAITING/DONE。

---

## 7. 模块迁移表

| 现模块 | 归宿 |
|--------|------|
| `kpiAdvancer` | 并入 `kpiManager.tick`（advance 子过程） |
| `staleBurstReaper` | 并入 `kpiManager.reapStaleBursts` |
| `kpi-dispatch-guard` | 简化或删除（多 burst 允许） |
| `inner-brain-kpi-reuse` / `burst-reuse` | 删除 canonical 复用；保留 burst 列表查询 |
| `sub-kpi-decomposer` | **删除** |
| `strategyPlanner` / `strategyStore` | **删除** |
| `autonomyTaskDispatcher` KPI 分支 | **已删除**；KPI → `kpiManager.tick`；闲聊 → `casualChatDispatcher` |
| `autonomyJudge` + `autonomyPolicyStore` | 并入 `environment/`（见 ENVIRONMENT-MODEL.md） |
| `kpi-spawn-capacity` | `environment/kpi-spawn-capacity.ts` — kpiManager / kpiAdvancer 读 facets 评估 spawn 槽位 |

---

## 8. 实现分期

| 阶段 | 内容 |
|------|------|
| **P0** | 本文 + `workspace.dsl`；`kpiManager` 心跳接线；strategy phase 删除 | ✅ 2026-06-07 |
| **P1** | 扁平 KPI + 多 burst 并行 + peer 互访 + R3/R4 awaiting review | ✅ 2026-06-07 |
| **P2** | 死代码清理（subKpiDecomposer/burstReuse/canonical）；`maxParallelBurstsPerKpi`；legacy heartbeat 禁 kpi_id | ✅ 2026-06-07 |
| **P3** | AWAITING LLM 审查；autonomyJudge 并入 environment/；删除 strategy/*；pipeline 接线 `awaitingReviewLlm` | ✅ 2026-06-07 |

---

## 9. 测试

| 类型 | 文件 |
|------|------|
| unit | `kpi-manager.test.ts`（R1–R6 表驱动） |
| unit | `brain-async-snapshot.test.ts`（dyflow AWAITING） |
| integration | `kpiManager.component.integration.test.ts` |
| 删除 | `strategy-planner*.test.ts`、`sub-kpi-decomposer.test.ts`（P1 后） |

---

## 10. 变更记录

| 日期 | 说明 |
|------|------|
| 2026-06-07 | P3：staleBurstReaper 迁入 kpi/；删除 strategy/*；environment/ 收 autonomyJudge+policy；R3 LLM 复审 |
| 2026-06-07 | P1：扁平 KPI + 多 burst + R3/R4 awaiting review |

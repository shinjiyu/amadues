# 内脑 AWAITING 生命周期与恢复（ADL 权威）

> **English:** Inner bursts pause in **AWAITING** when `pendings.json` waits on timers or humans. Recovery is **not** only `changeWatcher` polling: it requires **registry↔workspace reconciliation**, **deterministic IM resolve**, and **startup bootstrap**. Complements [`INNER-BRAIN-RESUME.md`](./INNER-BRAIN-RESUME.md) (RUNNING on agent restart).

与 [`doc/agent-data-state-machine.md`](../agent-data-state-machine.md) §4–§6 一致；本文档补齐此前 ADL/宪法未写清的 **registry 终态** 与 **用户回复必达** 路径。

**状态**：设计已定稿（2026-05-27）· **实现**：待按 P0→P2 落地（见 §8）

---

## 1. 问题陈述（设计层）

| 现象 | 根因（设计缺口） |
|------|------------------|
| registry 长期 **AWAITING**，磁盘已「目标已完成」 | 双状态机无 **reconcile**；`changeWatcher` 在 `unconsumed=0` 时不动作 |
| 用户在 IM 回复后内脑不继续 | 宪法写 **IMWatcher**，ADL 未接线；实际依赖外脑 **可选** `send_directive` |
| 9+ 条僵尸 AWAITING/BLOCKED | 无启动/周期 **收口**；`BLOCKED` 遗留仍占表 |

---

## 2. 双状态机（必须同时理解）

```text
┌──────────────────────── inner-brain-registry.json ────────────────────────┐
│  TaskRecord.status: RUNNING | AWAITING | DONE | STOPPED | ERROR          │
│  职责：外脑调度表 ——「要不要 spawn 子进程」                                  │
└───────────────────────────────────────────────────────────────────────────┘
         ▲ onExit(isBrainAwaitingAsync)              │
         │                                            │ spawn / stop
         ▼                                            ▼
┌──────────────────────── <workDir>/.brain/ ──────────────────────────────┐
│  controller-state.json  mode: AWAITING | EXECUTE | …                     │
│  pendings.json          pending | resolved(+consumed) | timed_out        │
│  职责：内脑真相 ——「在等什么、是否已 post_complete」                        │
└───────────────────────────────────────────────────────────────────────────┘
```

**原则**（写入 ADL `horizon.note`）：

1. **workDir 优先**：`brainAsyncSnapshot(workDir)` 是 registry 终态的判定依据之一。
2. **registry 是调度投影**：必须与 workDir 定期/事件对账，不能只靠单次 `onExit`。
3. **AWAITING ≠ 永远挂着**：`is_post_complete` 时 registry **必须** 变为 **DONE**。

---

## 3. `brainAsyncSnapshot`（只读视图）

| 字段 | 含义 |
|------|------|
| `is_async_waiting` | 仍在等 timer / 真人 / 非 all-complete 的 active pending |
| `is_post_complete` | 里程碑已完成；`awaitingReason` 或 `source=all-complete` |
| `active_pendings` | 供外脑 `read_inner_status` / Dashboard |
| `next_wake_at` | 最近 timer `execute_at` |

**实现入口**（已有）：`packages/server/src/outer/brain-async-snapshot.ts`

**ADL 模块**：`brainAsyncSnapshot`（Library 性质，挂在 `agentServer` 下，供 reconcile / resolver / tools 引用）

---

## 4. Registry 终态规则（权威表）

`registryLifecycleReconcile` 与 `innerSpawner.onExit` **共用** 下表（避免分歧）：

| 条件（按 workDir 快照） | registry.status | finishedAt | 是否 spawn |
|-------------------------|-----------------|------------|------------|
| 子进程 RUNNING 且 pid 存活 | RUNNING | — | 已运行 |
| `is_post_complete === true` | **DONE** | now | **否** |
| `is_async_waiting &&` 存在 `unconsumed resolved` | → RUNNING（由 changeWatcher spawn） | — | **是** |
| `is_async_waiting &&` 仅 `pending` ask_user/timer | **AWAITING** | — | 否（等 resolve / timer） |
| `!is_async_waiting && !is_post_complete` 且无 active pending | **DONE** | now | 否 |
| 用户 `stop` / signal | STOPPED | now | 否 |
| 子进程异常退出 | ERROR | now | 否 |

**`is_post_complete` 判定**（与单测一致）：

- `controller.awaitingReason === '目标已完成，等待新目标'`
- 或 `controller.blockedReason` 同上
- 或 `active_pendings` 中存在 `source === 'all-complete'`

**禁止**：`is_post_complete` 时 registry 仍为 AWAITING（假挂起）。

---

## 5. 新增 ADL 组件

### 5.1 `registryLifecycleReconcile`

| 属性 | 值 |
|------|-----|
| **职责** | 对齐 registry 与 workDir；消除假 AWAITING；启动时跑一次 + 可选周期 |
| **In** | `innerBrainRegistry.list()` + 各 `workDir` 的 `brainAsyncSnapshot` |
| **Out** | `registry.update(status, finishedAt)`；日志 `reconcile` |
| **计划路径** | `packages/server/src/outer/registry-lifecycle-reconcile.ts` |
| **触发** | `index.ts` 在 `changeWatcher.start()` **之前**；可选每 60s |

```text
foreach record in registry where status in (AWAITING, BLOCKED):
  snap = buildBrainAsyncSnapshot(record.workDir)
  if snap.is_post_complete → update DONE
  else if !snap.is_async_waiting → update DONE   // 无等待中的异步项
  // 仍 is_async_waiting → 保持 AWAITING，交给 changeWatcher
```

**BLOCKED**：reconcile 时视为 AWAITING 超集（迁移后不再新增 BLOCKED）。

### 5.2 `awaitingInboundResolver`

| 属性 | 值 |
|------|-----|
| **职责** | **确定性** IM 用户回复 → resolve `ask_user` pending → 由 changeWatcher spawn |
| **In** | `ChatIRInboundEvent`（人发、非 agent）+ `innerBrainRegistry` |
| **Out** | `resolvePending` on matched `workDir`；可选短 ack 经 `imClient` |
| **计划路径** | `packages/server/src/outer/awaiting-inbound-resolver.ts` |
| **挂载点** | `outerBrainFacade` 在 `participationPolicy` 之后、**进入** `outerConversationLoop` **之前** |

**匹配规则**（MVP）：

1. 仅处理 `sender` 为 human（非 `idp:agent:*`）。
2. 在同 `thread_id` 下找 `status ∈ {AWAITING, BLOCKED}` 的实例，按 `startedAt` **降序**。
3. 若仅 1 条 → 对该实例 `resolve` **最近一条** `kind=ask_user` 且 `status=pending`。
4. 若多条 → 正文含 `instance_id`（如 `` `ib-xxx` ``）则精确匹配；否则 **不自动 resolve**（外脑 `send_directive` 兜底）。
5. 正文以 `[NEW_GOAL]` 开头 → 不 resolve，交给 controller 新任务路径。

**与 `send_directive` 关系**：

| 路径 | 确定性 | 场景 |
|------|--------|------|
| **awaitingInboundResolver** | 高 | 用户在同 thread 回复阻塞问题 |
| **send_directive(feedback)** | 中（靠 LLM 调工具） | 外脑主动转发、指定 instance_id |

两条路径 **都** 写 `pendings.json`；**不** 直接 spawn（统一由 changeWatcher 触发，避免双 spawn）。

### 5.3 `changeWatcher`（修订职责）

在现有「1s 轮询 pendings」之上，ADL 明确三阶段：

| 阶段 | 行为 |
|------|------|
| **bootstrap**（`start()` 内一次） | 调用 `registryLifecycleReconcile`；`resolveDueTimers` 扫全表 AWAITING |
| **tick** | 对每个 AWAITING/BLOCKED：`expireOverdue` → 若有 `unconsumed resolved` 且 pid 不存活 → `spawnTask` |
| **不负责** | IM 入站（交给 resolver）；registry DONE 收口（交给 reconcile） |

宪法 §6.2 的 **IMWatcher** 合并进 **`awaitingInboundResolver`**；**TimerWatcher** 仍为 poll（v1），非最小堆。

---

## 6. 启动时序（修订后）

```text
agentServer load
  ├─ innerBrainRegistry.load
  ├─ innerBrainStartupResume()          // 仅 RUNNING 僵尸
  ├─ registryLifecycleReconcile()       // ★ 新增：AWAITING/BLOCKED 收口
  └─ listen 之后
        changeWatcher.start()
          ├─ bootstrap: reconcile + 全表 timer 补单
          └─ setInterval(tick)
        awaitingInboundResolver 挂载于 outerBrainFacade
        pushLoop.start()
```

---

## 7. 运行时序（用户回复）

```text
用户 IM 消息 (human, thread T)
  → outerBrainFacade
  → awaitingInboundResolver
        match AWAITING instance on thread T
        resolvePending(ask_user, reply=text)
  → (可选) participationPolicy + outerConversationLoop
  → changeWatcher.tick (≤1s)
        unconsumed resolved > 0
        spawnAndAttachWorker → RUNNING
  → innerWorker tick
        controller AWAITING → EXECUTE（消费 resolved）
```

---

## 8. 实现梯度

| 阶段 | 交付 | 验收 |
|------|------|------|
| **P0** | `registryLifecycleReconcile` + `changeWatcher.bootstrap` | 假 AWAITING（all-complete）→ DONE；启动后僵尸减少 |
| **P0** | `awaitingInboundResolver` 单实例 + 单 thread | 用户回复后 ≤2s 内 spawn，无需 LLM 调 send_directive |
| **P1** | 多实例 disambiguation（正文带 instance_id） | 同 thread 多 AWAITING 不误匹配 |
| **P1** | `read_inner_status` 返回 `async.*` 字段（已有快照） | 外脑 prompt 少误判 |
| **P2** | 周期 reconcile + metrics | Dashboard 见 reconcile 计数 |
| **P2** | 宪法 §6.3 tick.lock（可选） | 与文档对齐或删宪法表述 |

---

## 9. ADL 与测试映射

| 模块 ID | 视图 | 计划测试 |
|---------|------|----------|
| `brainAsyncSnapshot` | 08 / 内嵌 | 已有 `brain-async-snapshot.test.ts` |
| `registryLifecycleReconcile` | 08 | `registryLifecycleReconcile.test.ts` + component |
| `awaitingInboundResolver` | 07 | `awaitingInboundResolver.test.ts` + inbound integration |
| `changeWatcher` | 08 | 扩展 bootstrap + reconcile 联动 |

见 [`COMPONENT-TEST-MAP.md`](./COMPONENT-TEST-MAP.md)。

---

## 10. 修订

| 日期 | 说明 |
|------|------|
| 2026-05-27 | 初版：补 registry reconcile、IM 必达 resolver、changeWatcher bootstrap；修正宪法/ADL 漂移 |

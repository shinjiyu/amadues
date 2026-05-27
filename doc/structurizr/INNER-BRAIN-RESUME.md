# 外脑重启与内脑恢复 / Inner brain resume on agent restart

> **English:** When the **agentServer** process restarts, in-flight inner bursts must not be abandoned. Persisted `RUNNING` rows in `inner-brain-registry.json` are reconciled and the **same** `instanceId` / `workDir` is spawned again. **AWAITING** bursts use **changeWatcher** + **registryLifecycleReconcile** + **awaitingInboundResolver** (see [`INNER-BRAIN-AWAITING-LIFECYCLE.md`](./INNER-BRAIN-AWAITING-LIFECYCLE.md)).

与 [`doc/agent-data-state-machine.md`](../agent-data-state-machine.md) 一致：workspace 数据在磁盘；子进程可随时重建。

---

## 设计目标

| 目标 | 说明 |
|------|------|
| 外脑重启 ≠ 内脑作废 | 用户/外脑只重启 `agentServer`；`innerWorker` 子进程随父进程消失 |
| 恢复「执行中」 | registry 中 **RUNNING** 且子进程已死 → 再 spawn |
| 不重复开 instance | 同一 `instanceId`、同一 `workspaces/task-*` 目录 |
| 与 AWAITING 分工 | 等 timer / 等回复的任务进程本就可退出；由 **changeWatcher** 唤醒 + **reconcile** 收口 |
| AWAITING 完整设计 | [`INNER-BRAIN-AWAITING-LIFECYCLE.md`](./INNER-BRAIN-AWAITING-LIFECYCLE.md) |

**不在本设计范围**：KPI 仍为 `active` 但无 RUNNING burst 时自动派下一发（见 [`KPI-CLOSED-LOOP.md`](./KPI-CLOSED-LOOP.md)）。

---

## ADL 组件

| 模块 ID | 视图 | 实现 |
|---------|------|------|
| `innerBrainRegistry` | `08-L3-Outer-Inner-Lifecycle` | `outer/inner-brain-registry.ts` |
| `innerBrainStartupResume` | 同上 | `outer/inner-brain-startup-resume.ts`（`index.ts` 启动时调用） |
| `innerSpawner` | 同上 | `spawnAndAttachWorker()` |
| `changeWatcher` | 同上 | AWAITING：bootstrap + pendings 轮询 → spawn |
| `registryLifecycleReconcile` | 同上 | AWAITING/BLOCKED ↔ workDir 对账 → DONE |
| `awaitingInboundResolver` | `07-L3-Outer-Inbound-IM` | IM 人消息 → resolve pending |

---

## 启动时序（目标设计）

```text
agentServer 进程 load (index.ts)
  │
  ├─ innerBrainRegistry 从 data/inner-brain-registry.json 加载
  │
  ├─ autoResumeStaleTasks()              ← innerBrainStartupResume
  │     markStaleRunningAsStopped()      // RUNNING → STOPPED（记账）
  │     foreach stale:
  │       if resumeCount < max && UTLRA_INNER_AUTO_RESUME
  │         spawnAndAttachWorker(same record)  // status → RUNNING
  │
  ├─ registryLifecycleReconcile()        ← ★ INNER-BRAIN-AWAITING-LIFECYCLE §5.1
  │
  └─ listen() 之后
        changeWatcher.start()            // bootstrap + 扫 AWAITING/BLOCKED + pendings
        outerBrainFacade 挂载 awaitingInboundResolver
        pushLoop / heartbeat / channel …
```

> **实现现状**：`registryLifecycleReconcile` / `awaitingInboundResolver` / `changeWatcher.bootstrap` 为 **待实现**（2026-05-27 设计已定稿）。当前仅 `innerBrainStartupResume` + 轮询版 `changeWatcher`。

---

## 状态分工

| registry.status | 子进程在重启瞬间 | 重启后谁负责 |
|-----------------|------------------|--------------|
| **RUNNING** | 已死（僵尸行） | **innerBrainStartupResume** → spawn |
| **AWAITING** | 本就可能已退出 | **changeWatcher**（timer / unconsumed resolved → spawn） |
| **AWAITING**（假挂起） | 已 post_complete | **registryLifecycleReconcile** → **DONE** |
| DONE / STOPPED / ERROR | 已结束 | 无自动 spawn |

---

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `UTLRA_INNER_AUTO_RESUME` | `1` | `0` = 只标 STOPPED，不 spawn |
| `UTLRA_INNER_MAX_AUTO_RESUME` | `3` | 同一 instance 自动恢复次数上限（防永动机） |

手动恢复：`POST /api/inner-brains/:id/restart`（**不**增加 `resumeCount`）。

---

## 数据依赖

| 路径 | 角色 |
|------|------|
| `data/inner-brain-registry.json` | 哪些 burst 在跑 / 曾跑 |
| `data/workspaces/<task-*>/.brain/` | goal、milestones、pendings、controller-state |
| `data/workspaces/<task-*>/.run/` | worker 状态（git 通常 ignore） |

重启后内脑从 **workDir 文件** 继续；registry 只负责「要不要拉进程」。

---

## 与 KPI onExit 的边界

- **Resume 成功退出** 时仍走 `spawnAndAttachWorker` 的 **onExit** → `processBurstExitForKpi`（trail / idle / meta burst）。
- **重启瞬间** 对被杀的 RUNNING burst **不会**先跑 onExit；KPI 记账可能滞后，直到 resume 后再次正常退出。
- 若需「重启即 KPI 结账」，属增强项，不在当前实现。

---

## 测试

| 层级 | 位置 |
|------|------|
| 单元 | `inner-brain-registry.test.ts`（markStale）；`inner-brain-startup-resume.test.ts`（resume 策略） |
| 组件集成 | `innerBrainStartupResume.component.integration.test.ts`（磁盘持久化 + mock spawn） |
| 子进程 live | `spawn-inner-worker-live.integration.test.ts`（可选 `UTLRA_TEST_SPAWN_INNER=1`） |

---

## 修订

| 日期 | 说明 |
|------|------|
| 2026-05-21 | 初版：补 ADL 组件 `innerBrainStartupResume`、L3 边、本文档（实现已存在于 index.ts，此前 DSL 未描述） |
| 2026-05-27 | 链出 AWAITING 专篇；启动序增加 reconcile；区分 RUNNING resume 与 AWAITING 收口 |

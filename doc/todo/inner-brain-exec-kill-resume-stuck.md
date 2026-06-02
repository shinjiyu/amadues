# 内脑 EXECUTE 中被杀 → 重启卡住

> **状态**：待实现（仅分析 + 方案，2026-06-01）  
> **关联 ADL**：[`INNER-BRAIN-RESUME.md`](../structurizr/INNER-BRAIN-RESUME.md)、[`INNER-BRAIN-AWAITING-LIFECYCLE.md`](../structurizr/INNER-BRAIN-AWAITING-LIFECYCLE.md)

---

## 1. 现象

内脑在 **EXECUTE** 阶段执行 `shell_exec` / `shell_exec_bg` 等工具时，worker 子进程被强杀（`taskkill`、OOM、手动 kill、外脑进程异常等）。之后无论：

- **外脑 agent 重启**（期望 `innerBrainStartupResume` 自动恢复），或  
- **用户手动 `/restart`**（`POST /api/inner-brains/:id/restart`）

任务表现为 **卡住**：registry 长期 **RUNNING** 且 `pid_alive=false`，或 restart 返回 **409**，或 spawn 后 worker 立刻 idle 退出但 milestone 无进展。

---

## 2. 架构背景（双状态机）

```text
inner-brain-registry.json          <workDir>/.brain/
  status: RUNNING|AWAITING|…  ←→   controller-state.json (mode: EXECUTE|ATTRIBUTE|…)
  pid                              pendings.json
                                   execution-context.json（EXECUTE 完成后才写入）
```

- **registry** 决定「要不要 spawn 子进程」  
- **workDir** 是内脑执行真相  
- 现有恢复链路分工：
  - **agent 冷启动**：`markStaleRunningAsStopped` → `autoResumeStaleTasks`（仅 **RUNNING** 行）
  - **AWAITING**：`changeWatcher` + `registryLifecycleReconcile`
  - **RUNNING + 死 pid（运行时）**：**无专门 reconciler**

---

## 3. 根因分析

### 3.1 【P0】RUNNING 僵尸行 — 调度层缺口

| 机制 | 覆盖范围 | EXECUTE 中被杀后的行为 |
|------|----------|------------------------|
| `onExit`（`spawnAndAttachWorker`） | worker 正常触发 exit | 通常 → **STOPPED**（signal）或 **AWAITING**；**应**清 `pid` |
| `innerBrainStartupResume` | **仅 agent 冷启动** | 所有 RUNNING → STOPPED 再 auto-spawn |
| `changeWatcher` | **仅** AWAITING/BLOCKED | **忽略 RUNNING** |
| `registryLifecycleReconcile` | AWAITING/BLOCKED → DONE | **显式不碰 RUNNING**（见单测 `RUNNING and DONE rows are untouched`） |
| `POST .../restart` | 手动恢复 | **`status === 'RUNNING'` 直接 409**（「正在运行中，无需重启」） |
| `GET .../inner-brains` enrichment | 展示 | 已能标 `liveness=dead`，但**不触发恢复** |

**卡住路径 A（最常见）**：

1. worker 在 EXECUTE 中被杀  
2. `onExit` **未执行完** registry 更新（父进程崩溃、onExit 内抛错、极端 Windows 子进程 exit 丢失等）  
3. registry 仍为 **RUNNING + stale pid**  
4. 用户点 restart → **409**；changeWatcher 不扫；无周期 watchdog  
5. 外显：**dead 但无法重启**

**临时绕过**：先 `POST .../stop`（`stopInnerBrainInstance` 对 RUNNING 且 pid 已死仍会把 registry 标 STOPPED），再 restart。

### 3.2 【P0】restart API 与 liveness 语义冲突

```1384:1390:packages/server/src/index.ts
app.post('/api/inner-brains/:id/restart', async (c) => {
  ...
  if (record.status === 'RUNNING') {
    return c.json({ error: `实例 ${id} 正在运行中，无需重启` }, 409);
  }
```

- `list-inner-brain-instances` 已用 `isPidAlive` 区分 **active / dead**  
- restart 却**不检查 pid 是否存活**，导致 zombie RUNNING 无法走主恢复路径

### 3.3 【P1】onExit 无 fault-tolerance

`onExit` 回调**无 try/finally**：若 `processBurstExitForKpi` / `eng.syncAfterPiMonoAuto` 抛错，registry 可能永久停在 RUNNING。

### 3.4 【P1】EXECUTE 中途被杀的磁盘状态

| 文件 | 被杀时机 | 重启后状态 |
|------|----------|------------|
| `controller-state.json` | `runExecutor` 进行中 | `mode=EXECUTE`（正常，应重跑 milestone） |
| `execution-context.json` | 仅在 executor **整轮结束**后写入 | 通常**不存在**；若存在且 mode 仍为 EXECUTE → 短暂不一致（下轮 EXECUTE 会覆盖） |
| `.run/pi-mono/.jobs/<id>/` | `shell_exec_bg` 已启动 | stdout/stderr 在磁盘，但 **`jobRegistry` 在 worker 内存**，重启后 `shell_read_output` → `job not found` |
| 孤儿 OS 进程 | bg shell 可能存活 | 新 worker 无 job 句柄，可能重复启动或误判 |

**卡住路径 B**：resume 后进入 EXECUTE，LLM 反复 `shell_read_output` 旧 job_id → 失败循环 / 空转，直到 `max_ticks` 或外脑误判「无进展」。

**卡住路径 C**：sync `shell_exec` 被 kill 时，**无** pending/timer；registry 正确 STOPPED 后 restart，一般会重跑 EXECUTE — 此路径通常**不卡**，除非叠加 3.1 僵尸行。

### 3.5 【P2】仅 agent 冷启动才 mark stale

`markStaleRunningAsStopped` **不检查 pid**，只在 boot 调用。运行时 worker-only 死亡完全依赖 `onExit` 一条路径，缺少 **runningWorkerReconcile** 兜底。

### 3.6 【P2】auto-resume 上限与 EXECUTE 重入

agent 重启时若 `resumeCount >= UTLRA_INNER_MAX_AUTO_RESUME`（默认 3），任务留 **STOPPED**，需手动 restart — 此路径设计正确，但若 KPI 循环 + EXECUTE 反复被杀，用户可能误以为「卡住」。

---

## 4. 修复方案（建议分阶段）

### Phase 0 — 止血（小 diff，优先）

1. **`POST /restart` 允许 dead RUNNING**  
   - 若 `status === 'RUNNING' && pid != null && !isPidAlive(pid)` → 视为 stale，允许 spawn（或先 implicit STOPPED 再 spawn）  
   - 若 RUNNING 且 pid 存活 → 保持 409

2. **`runningWorkerReconcile`（运行时 watchdog）**  
   - 挂到现有 `startRegistryLifecycleReconcileInterval` 或 changeWatcher tick 末尾  
   - 规则：`RUNNING && pid != null && !isPidAlive(pid)` →  
     - 读 `brainAsyncSnapshot` / `controller-state.json`  
     - 若 `is_async_waiting` → **AWAITING**（清 pid）  
     - 否则 → **STOPPED**（`errorMessage: worker exited without onExit`）  
   - 可选：`UTLRA_INNER_AUTO_RESUME_RUNTIME=1` 时立即 `spawnAndAttachWorker`（与冷启动共用 resumeCount 预算）

3. **onExit 包 try/finally**  
   - KPI hook 失败仍必须 `registry.update` 终态 + 清 pid  
   - finally 里打 `[inner-brain] onExit registry finalize` 日志

### Phase 1 — EXECUTE 恢复语义

4. **Worker 启动时 EXECUTE 孤儿清理**（`spawnAndAttachWorker` 或 worker `main` 开头）  
   - 扫描 `.run/pi-mono/.jobs/*/`：若 `meta.json` 含 pid 且 `!isPidAlive` → 写 `exit_code` / `orphaned=true`  
   - 重建内存 `jobRegistry` 的**只读视图**（或让 `shell_read_output` 回退读磁盘 meta）  
   - 文档：`doc/protocols/shell-exec-bg.md` 增「worker 重启后 job 恢复」

5. **controller EXECUTE 入口幂等**  
   - 若 `mode === 'EXECUTE'` 且存在**不完整** execution-context（可选：mtime 与 last worker start 比较）→ 打 warn，继续重跑 milestone（当前行为基本 OK，补日志 + ADL 说明）

6. **ATTRIBUTE 无 context 回退**（已有）  
   - 保持 `attribute.no.context` → EXECUTE；单测覆盖 kill 在 ATTRIBUTE 中间的场景

### Phase 2 — ADL + 测试

7. **Structurizr 更新**（实现前按仓库规则）  
   - `INNER-BRAIN-RESUME.md`：增 **§ RUNNING + dead pid（运行时）**  
   - `INNER-BRAIN-AWAITING-LIFECYCLE.md` §4 终态表补一行：`RUNNING && !pidAlive` → STOPPED/AWAITING + optional spawn  
   - `components/agent-server.dsl`：`runningWorkerReconcile` 组件边  
   - `COMPONENT-TEST-MAP.md`：新测项 ⏳

8. **测试矩阵**

   | 层级 | 场景 |
   |------|------|
   | 单元 | `runningWorkerReconcile`：RUNNING+dead→STOPPED；RUNNING+dead+timer pending→AWAITING |
   | 单元 | restart API：RUNNING+alive→409；RUNNING+dead→200 |
   | 单元 | onExit：KPI hook throw 仍更新 registry |
   | 组件 | mock spawn：EXECUTE 中杀 worker → reconcile → restart → controller mode 推进 |
   | 组件 | shell_exec_bg 启动后杀 worker → restart → shell_read_output 可读磁盘 job |
   | live 可选 | `UTLRA_TEST_SPAWN_INNER=1` taskkill worker mid-exec |

---

## 5. 决策点（实现前需确认）

| # | 问题 | 建议默认 |
|---|------|----------|
| D1 | 发现 RUNNING+dead 后**自动 spawn**还是只改 STOPPED？ | 默认**只改 STOPPED**（与 onExit 语义一致）；auto-spawn 用 env 开关 |
| D2 | bg job 恢复：重建 registry vs 让 LLM 重跑命令？ | **磁盘 meta + 只读恢复**优先，减少重复副作用 |
| D3 | Windows kill：exitCode≠0 且 signal=null 当前标 **ERROR** | 保持；restart 对 ERROR 已可用 |
| D4 | 手动 restart 是否应 kill 残留 pid？ | 若 pid 存活应先 SIGTERM（与 stop 对齐） |

---

## 6. 实现顺序（Structurizr-first）

1. 更新 ADL（§7 上述文档 + DSL）  
2. 红测：`running-worker-reconcile.test.ts`、`restart-dead-running.test.ts`  
3. Phase 0 代码 → 绿  
4. Phase 1 job 恢复 → 绿  
5. `npm run test:integration -w @utlra/server`

---

## 7. 相关代码索引

| 模块 | 路径 |
|------|------|
| spawn / onExit | `packages/server/src/index.ts` — `spawnAndAttachWorker` |
| 冷启动 resume | `packages/server/src/outer/inner-brain-startup-resume.ts` |
| changeWatcher | `packages/server/src/pi-mono/change-watcher.ts` |
| reconcile | `packages/server/src/outer/registry-lifecycle-reconcile.ts` |
| restart 409 | `packages/server/src/index.ts` L1384 |
| liveness dead | `packages/server/src/outer/list-inner-brain-instances.ts` |
| stop 兜底 | `packages/server/src/outer/stop-inner-brain.ts` |
| EXECUTE 状态机 | `packages/server/src/openkuroneko/controller/controller.ts` |
| shell job 内存 | `packages/server/src/openkuroneko/process/exec-runner.ts` |
| worker 入口 | `packages/server/src/pi-mono/inner-brain-worker.ts` |

---

## 8. 修订

| 日期 | 说明 |
|------|------|
| 2026-06-01 | 初版：EXECUTE 中被杀 → 重启卡住；根因 + 分阶段修复方案 |

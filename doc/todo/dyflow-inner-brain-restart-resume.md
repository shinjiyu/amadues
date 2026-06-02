# 内脑随意重启 / 恢复（DyFlow 对齐）

> **状态**：legacy **已实现**；DyFlow **待验证 + 与卡住修复对齐**（2026-06-02）  
> **关联 ADL**：[`INNER-BRAIN-RESUME.md`](../structurizr/INNER-BRAIN-RESUME.md)、[`INNER-BRAIN-AWAITING-LIFECYCLE.md`](../structurizr/INNER-BRAIN-AWAITING-LIFECYCLE.md)、[`DYFLOW-INNER-EXECUTOR.md`](../structurizr/DYFLOW-INNER-EXECUTOR.md)  
> **卡住专篇**：[`inner-brain-exec-kill-resume-stuck.md`](./inner-brain-exec-kill-resume-stuck.md)

---

## 1. 已实现能力（勿丢）

用户/运维应能**随时**恢复在途内脑，而不必重开 KPI：

| 入口 | 行为 |
|------|------|
| **Agent 进程重启** | `innerBrainStartupResume`：registry `RUNNING` → 同 `instanceId` / `workDir` 再 spawn（`UTLRA_INNER_AUTO_RESUME`） |
| **手动** | `POST /api/inner-brains/:id/restart`（**不**占 `resumeCount`） |
| **停止** | `POST …/stop` → 再 restart |
| **外脑心跳** | 质控：stuck / dead 暴露给 LLM、Dashboard（部分自动干预 ⏳） |

代码：`inner-brain-startup-resume.ts`、`spawnInnerBrainWorker`、`index.ts` restart 路由。

---

## 2. DyFlow 下多出来的持久化

重启后 worker 应续跑 **同一 burst**，除 registry 外还依赖：

| 文件 | 用途 |
|------|------|
| `.brain/dyflow-state.json` | `DESIGN` / `RUN` / `DONE` |
| `.brain/local_dag.json` | 当前轮 DAG（RUN 中可能存在） |
| `.brain/memory.json` | `node_results`、`facts`、`last_failure` |
| `.brain/local_nodes/` | preset + 已 pack 的 local 节点 |

**待验证**：kill worker / `dev:agent:bot2:stop` + 再拉起 / `POST restart` 后，controller 从 `dyflow-state.mode` 正确续跑，**不**误回 legacy `controller-state.json`（`INNER_BRAIN_ENGINE=dyflow` 时）。

---

## 3. 已知缺口（与「随意重启」冲突）

见 [`inner-brain-exec-kill-resume-stuck.md`](./inner-brain-exec-kill-resume-stuck.md)：

- RUNNING 但 `pid` 已死 → **restart 409**（应允许 dead RUNNING restart）
- legacy EXECUTE + `shell_exec_bg`：job 在内存，重启后 `job not found`
- DyFlow baseNode 后台 job：同上，需文档或 P2 从磁盘 job 目录恢复

---

## 4. 待办

- [ ] **组件测**：dyflow burst RUN 中杀 worker → auto-resume 或 manual restart → `mode`/`memory` 连续，pi-mono 从下一 tick 继续。
- [ ] **组件测**：`dyflow-state=DESIGN` 杀 worker → restart → Designer 不丢 `last_failure`。
- [x] 修复 restart 409（`inner-brain-restart-policy.ts` + Dashboard dead 续跑）。
- [ ] ADL：`INNER-BRAIN-RESUME.md` 增 DyFlow 小节；`COMPONENT-TEST-MAP.md` 登记测项。
- [x] Dashboard：dead 续跑按钮 + DyFlow 内脑实况（`inner-live.tsx` / brain-inspector `dyflow`）。
- [ ] 组件测：dyflow RUN 中杀 worker → 续跑（仍待）。

---

## 5. 验收

- [ ] bot2 类 DyFlow 任务：运行中 `npm run dev:agent:bot2:stop` → 再 start → burst 仍为 RUNNING 且从 `dyflow-state` 续跑。
- [ ] `POST /api/inner-brains/:id/restart` 在 pid 已死时 **200**，非 409。
- [ ] 文档与 todo `inner-brain-exec-kill-resume-stuck` 状态同步（避免重复方案）。

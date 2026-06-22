# 外脑重启与内脑恢复 / Inner brain resume on agent restart

> **⚠️ 2026-06-07**：启动 **auto-resume**（`innerBrainStartupResume`）已删除。见 [`INNER-BRAIN-STARTUP-RESUME-REMOVED.md`](./INNER-BRAIN-STARTUP-RESUME-REMOVED.md)。下文历史描述中 auto-spawn 部分已过时。

> **English:** On **agentServer** restart, stale `RUNNING` rows are **marked STOPPED** only. **AWAITING** uses **changeWatcher**; KPI uses **kpiAdvancer**; manual **`POST /api/inner-brains/:id/restart`**.

与 [`doc/agent-data-state-machine.md`](../agent-data-state-machine.md) 一致：workspace 数据在磁盘；子进程可随时重建。

---

## 当前行为（2026-06-07 起）

| registry.status | 重启后 |
|-----------------|--------|
| **RUNNING** | `markStaleRunningAsStopped()` → **STOPPED**（不 spawn） |
| **AWAITING** | **changeWatcher**（timer / resolved → spawn） |
| DONE / STOPPED / ERROR | 无自动 spawn |

手动续跑：`POST /api/inner-brains/:id/restart`。

KPI 下一发：`kpiAdvancer` / `advance_kpi` / `POST /api/kpis/:id/dispatch`。

---

## 历史设计（auto-resume 已删）

<details>
<summary>展开：原 innerBrainStartupResume 设计</summary>

原 intent：RUNNING 僵尸 → 同 instance 再 spawn（`UTLRA_INNER_AUTO_RESUME` / `resumeCount`）。与 KPI onExit 续跑同属「无节拍 respawn」，已移除。

</details>

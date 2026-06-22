# 已移除：外脑启动 auto-resume（innerBrainStartupResume）

> **English:** Removed startup auto-respawn of stale `RUNNING` rows. Boot now only **marks STOPPED**. Continuation: **ChangeWatcher** (AWAITING), **kpiAdvancer** (KPI), **POST /api/inner-brains/:id/restart** (manual).

**状态**：2026-06-07 起代码已删除；替代 [`INNER-BRAIN-RESUME.md`](./INNER-BRAIN-RESUME.md) 中的 auto-resume 章节。

---

## 曾有的机制（已删）

| 模块 | 原意图 | 为何移除 |
|------|--------|----------|
| **innerBrainStartupResume** | agent 重启 → `markStale` → 同 instance 再 spawn（`UTLRA_INNER_AUTO_RESUME`） | 与 kpi onExit 续跑同类永动机；KPI/AWAITING 已有专用路径 |
| **resumeCount** / **UTLRA_INNER_MAX_AUTO_RESUME** | 限制 auto-resume 次数 | 随 auto-resume 一并废弃（字段保留只读兼容） |

---

## 保留

| 场景 | 机制 |
|------|------|
| 启动清僵尸 RUNNING | `innerBrainRegistry.markStaleRunningAsStopped()`（`index.ts` boot） |
| AWAITING 续跑 | **ChangeWatcher** |
| KPI 下一发 | **kpiAdvancer**（心跳 / advance_kpi） |
| 人工续跑 | `POST /api/inner-brains/:id/restart` |

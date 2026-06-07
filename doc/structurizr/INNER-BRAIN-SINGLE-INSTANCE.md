# 内脑单实例复用（同一目标禁止多开）

> **English:** One **canonical inner brain** per KPI / long-running goal. Each EXECUTE cycle advances incrementally on the **same** `instanceId` + `workDir`; the plan is revised between cycles—not multiple parallel inner brains collaborating on one target.

与 [`KPI-CLOSED-LOOP.md`](./KPI-CLOSED-LOOP.md)、[`INNER-BRAIN-AWAITING-LIFECYCLE.md`](./INNER-BRAIN-AWAITING-LIFECYCLE.md)、[`KPI-ADVANCEMENT.md`](./KPI-ADVANCEMENT.md) 互补。  
**粒度（2026-06-07）**：canonical 绑定 **leaf sub-KPI**（非父 KPI）；多轮 sprint 复用同一 instance，执行史见 `burstRunHistory`。

---

## 1. 设计意图（vs spec 式规划）

| 维度 | spec / 多 burst 旧模式 | 目标模式 |
|------|------------------------|----------|
| 规划 | 一次大 plan 走到底 | 每轮 EXECUTE 只靠近目标一点，再 REVIEW/REPLAN |
| 实例 | 同 KPI 多次 `set_goal` → 多个 `task-ib-*` | **一个** canonical instance，续跑复用 |
| 协作 | 同 KPI sibling workspace **完全互读**；spawn 只写 `.inbox/` 名字+摘要 | 见 [`INNER-WORKSPACE-INBOX.md`](./INNER-WORKSPACE-INBOX.md) |
| 记忆 | 分散在多个 workspace | 集中在同一 `.brain/`（`memory.json`、`local_nodes/`、deliverables） |

outcome 换向续跑（`scheduleNextKpiBurst`）也落在 **同一 canonical instance** 上，不另开 workspace。

---

## 2. 规则

| 规则 | 行为 |
|------|------|
| **R1** | 带 `kpi_id` 的 `set_goal`：若 KPI 已有 canonical instance 且非 LIVE → **续跑**该 instance，不 `register` 新行 |
| **R2** | 带 `kpi_id` 且已有 LIVE（RUNNING/AWAITING/BLOCKED）→ **拒绝**并行派发 |
| **R3** | `scheduleNextKpiBurst`（outcome 换向续跑）→ 仅 `spawnAndAttachWorker(canonical)`，不 `generateInstanceId()` |
| **R4** | 同 KPI sibling workspace 默认 peer 互读；spawn 写 `.inbox/` 目录（名字+摘要，无正文） |
| **R5** | Canonical = `kpi.canonicalInstanceId` 或 `kpi.bursts[0]`（`isReflexionBurst` 字段已废弃） |

---

## 3. ADL 组件

| 模块 ID | 路径 | 职责 |
|---------|------|------|
| `innerBrainKpiReuse` | `outer/inner-brain-kpi-reuse.ts` | `findCanonicalBurstForKpi`、goal 续写、`isSetGoalDispatched` |
| `outerToolExecutor` | `outer/outer-tools.ts` | `set_goal` 走 R1/R2/R4 |
| `innerSpawner` | `index.ts` `spawnAndAttachWorker` | KPI outcome 换向续跑 spawn |

---

## 4. 测试

| 类型 | 文件 |
|------|------|
| 单测 | `inner-brain-kpi-reuse.test.ts` |
| 组件 | ⏳ `set_goal` 续跑 mock spawn |

---

## 5. 修订

| 日期 | 说明 |
|------|------|
| 2026-06-02 | 初版：单实例复用；禁止同 KPI 多 workspace |
| 2026-06-02 | DSL：`innerBrainKpiReuse` 组件 + workspace 边 + L3 view 08/10b |

# 内脑 Workspace 保留与历史查询上限

> **English:** Prevents OuterBrain event-loop stalls and disk growth from unbounded `inner-brain-registry` / `workspaces/task-*`. Two layers: (1) hard cap on `read_inner_status(include_history)` rows; (2) heartbeat-level retention that removes **terminal** registry rows and their workDirs.

> **状态**：设计定稿 · 实现 P0（2026-07-28）

---

## 1. 问题

`read_inner_status(include_history=true)` 会对注册表**每一条**同步读盘（status / async snapshot）。Shiro 等长寿 agent 可达 1000+ 条时，单次工具调用占满 Node 事件循环 → `/api/health` 超时、心跳 `previous tick still running`、IM 假死。

并行地，`DATA_ROOT/workspaces/task-*` 只增不减（生产无删除路径）。

---

## 2. 两层策略

| 层 | 组件 | 行为 |
|----|------|------|
| **A. 查询护栏** | `outerToolExecutor` / `execReadInnerStatus` | `include_history=true` 时只返回最近 `historyCap` 条（`startedAt` desc，与 `list()` 一致）；响应带 `truncated` / `history_cap` / `registry_total`。live 路径不变。 |
| **B. 数据淘汰** | `innerWorkspaceRetention` | 心跳 tick（与 `sweepKpiCompletions` 同级）：仅处理终态 `DONE\|STOPPED\|ERROR\|ABORTED`；**永不**动 `RUNNING\|AWAITING\|BLOCKED`。 |

### B 规则（对齐 nodeDefEviction 形态）

1. **cold**：终态且 `finishedAt ?? abortedAt ?? startedAt` 距今 > `coldDays` → 删 registry 行 + 可选 `rm` workDir  
2. **quota**：终态条数 > `maxTerminal` → 按结束时间升序淘汰到 `floor(maxTerminal * (1-headroom))`（保留较新）

磁盘删除仅当 `workDir` 解析后位于 `<dataRoot>/workspaces/` 之下。

---

## 3. 配置（env）

| 变量 | 默认 | 含义 |
|------|------|------|
| `UTLRA_INNER_STATUS_HISTORY_CAP` | `50` | `include_history` 最大行数 |
| `UTLRA_INNER_WORKSPACE_MAX_TERMINAL` | `400` | 终态条数上限 |
| `UTLRA_INNER_WORKSPACE_COLD_DAYS` | `45` | cold 天数 |
| `UTLRA_INNER_WORKSPACE_RETENTION` | `1` | `0`/`false` 关闭淘汰 |
| `UTLRA_INNER_WORKSPACE_RETENTION_BATCH` | `25` | 单次心跳最多删几条（防同步 rm 堵死事件循环） |

---

## 4. API / 落盘

- `InnerBrainRegistry.remove(instanceId)`：Map + JSON 持久化；失效 `list()` 缓存  
- `runInnerWorkspaceRetention(registry, { dataRoot, … })` → `{ removed, scannedTerminal, remainingTerminal }`  
- 调用点：`OuterHeartbeat._tick`，在 `sweepKpiCompletions` 之后、`triggerDigitalEmployee` 之前

---

## 5. 与 Inbox / 观测的关系

- [`INNER-WORKSPACE-INBOX.md`](./INNER-WORKSPACE-INBOX.md)：peer workspace 可能被淘汰；catalog 里失效 id 由读侧容忍（已有缺失路径）  
- [`TASK-RUN-OBSERVABILITY.md`](./TASK-RUN-OBSERVABILITY.md)：历史指标勿假设 registry 永久保留；冷数据需事先导出

---

## 6. 测试

- `inner-workspace-retention.test.ts`：cold / quota / 不碰 live / path 安全  
- `inner-brain-registry.test.ts`：`remove` 持久化  
- `read-inner-status-history-cap.test.ts`：`include_history` 截断字段  

见 [`COMPONENT-TEST-MAP.md`](./COMPONENT-TEST-MAP.md)。

---

## 7. 修订

| 日期 | 说明 |
|------|------|
| 2026-07-28 | 初版：history cap + terminal retention（Shiro 假死事后） |

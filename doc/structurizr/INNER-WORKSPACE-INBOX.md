# 同 KPI 内脑互读 + 产物目录（`.inbox/`）

> **English:** All inner-brain workspaces under the **same KPI** are **fully readable** peers (`read_peer_file` / `list_peer_files`). On spawn, only a **name + summary catalog** is written to `.inbox/` — **no file body copy**. Full content is fetched on demand via peer tools.

与 [`INNER-BRAIN-SINGLE-INSTANCE.md`](./INNER-BRAIN-SINGLE-INSTANCE.md)、[`doc/protocols/inner-brain-deliverables.md`](../protocols/inner-brain-deliverables.md) 互补。

---

## 1. 设计原则

| 原则 | 行为 |
|------|------|
| **同 KPI 完全互读** | 挂 `kpi_id` 的 burst 自动注入该 KPI 下**全部 sibling** workspace 为 peer |
| **不传正文** | spawn 时只写 `.inbox/catalog.json` + `README.md`（路径、字节数、~280 字摘要） |
| **按需取正文** | executor 用 `read_peer_file` / `list_peer_files` / `search_peer_files` |
| **非 KPI** | 仅 `peer_workspace_ids` 显式指定的 workspace |

---

## 2. 数据流

```
KPI bursts: task-ib-A (写稿)  task-ib-B (发布)
                    │
        set_goal(kpi_id=…)  spawn
                    │
    ├─ INNER_PEER_WORKSPACE_IDS = A,B,…（互读）
    └─ .inbox/README.md       名字 + 摘要（无正文复制）
                    │
        executor: read_peer_file("task-ib-A", "novel_full.md")
```

---

## 3. 规则

| 规则 | 行为 |
|------|------|
| **R1** | `collectPeerWorkspaceIds`：explicit ∪ 同 KPI 全部 sibling（排除自身） |
| **R2** | `writePeerCatalog`：摘要来自 deliverables.log + deliverables.json 登记路径 |
| **R3** | resume / restart（`spawnAndAttachWorker`）同样刷新 peer + catalog |
| **R4** | 正文按需读：见 [`INNER-FILE-ACCESS.md`](./INNER-FILE-ACCESS.md)（⏳ `offset_line`/`limit_lines`）；禁止 spawn 灌全文 |
| **R5** | `.inbox/` 对本 burst 只读（catalog 由外脑 spawn 写入） |
| **R6** | `INNER_PEER_WORKSPACE_IDS` = 同 KPI sibling + explicit peer |

---

## 4. ADL 组件

| 模块 ID | 路径 | 职责 |
|---------|------|------|
| `workspaceInbox` | `outer/workspace-inbox.ts` | `collectPeerWorkspaceIds`、`writePeerCatalog` |
| `outerToolExecutor` | `outer/outer-tools.ts` | `set_goal` spawn |
| `innerSpawner` | `index.ts` `spawnAndAttachWorker` | resume 时 peer + catalog |
| `workdirGuard` | `workdir-guard.ts` | peer 只读；`.inbox/` 不可写 |

---

## 5. 测试

| 类型 | 文件 |
|------|------|
| 单测 | `workspace-inbox.test.ts` |

---

## 6. 修订

| 日期 | 说明 |
|------|------|
| 2026-06-01 | 初版：`.inbox/` hardlink 物化 |
| 2026-06-01 | 改为同 KPI 互读 + 目录（名字/摘要），不再复制正文 |

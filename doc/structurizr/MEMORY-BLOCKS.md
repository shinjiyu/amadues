# Memory Block 抽象（ADL 权威）

> **English:** Agent-owned **notebook memory** — typed blocks with pluggable strategies. Persistent, non-evicting CRUD at block + entry level. Evolves the outer memory stack alongside mem9 / drive9 / repository.

**状态**：B0–B1 ✅ vault + entry CRUD · **B2 解耦** ✅ · **B3** ✅ 块级 CRUD + `notebook` + Dashboard 只读 API

关联：[`MEMORY-STORAGE-BOUNDARY.md`](./MEMORY-STORAGE-BOUNDARY.md) · [`doc/todo/memory-blocks-framework.md`](../todo/memory-blocks-framework.md)

**原则**：Memory Block 是外脑第四层记忆（记事本），**不**耦合 AWAITING 生命周期或内脑 workDir。外脑 CRUD 后，需要时自行把关键内容写入 `set_goal` / `send_directive` / IM 回复交给内脑。

---

## 1. 在记忆栈中的位置

| 层 | 隐喻 | 写入 | 淘汰 |
|----|------|------|------|
| mem9 | 软回忆、信念 | 追加 + 语义检索 | 降权 / supersede |
| drive9 skills | 可复用步骤 | `write_skill` | 版本迭代 |
| repository K/S/P | 执行产物 | promote | 归档 |
| **Memory Block** | **记事本** | Agent 自选 CRUD | **不自动淘汰**（仅显式 delete） |

`keychain`（`kv_secret`）是预置块之一，不是 Block 系统的全部。

---

## 2. 概念

```text
MemoryBlockRegistry (per agent, 不互通)
  block_id: keychain      → strategy: kv_secret   (凭证，prompt 脱敏)
  block_id: <agent 自建>  → strategy: notebook   (通用记事本，可读)

存储（仅本地，按 Agent 的 DATA_ROOT 隔离）：
  DATA_ROOT/vault/blocks/blocks-index.json
  DATA_ROOT/vault/blocks/{block_id}/entries/{key}.json
```

| 概念 | 说明 |
|------|------|
| **Block** | 命名空间 + strategy（本子） |
| **Entry** | 块内一条记录（页） |
| **Strategy** | schema、脱敏、是否可进外脑 prompt |

**B3**：Agent CRUD **块**（`memory_block_create` / `update` / `delete_block`）+ CRUD **记录**（`put` / `get` / `delete`）；用户块索引 `vault/blocks/blocks-index.json`。

---

## 3. 策略表

| strategy | 示例 block | 外脑 prompt | 说明 |
|----------|------------|-------------|------|
| `kv_secret` | `keychain` | 无 value | Cookie / Token |
| `notebook` | （Agent 自建） | 可读摘要/全文 | 通用记事本（B3） |

---

## 4. 外脑工具（`outerToolExecutor`）

| 工具 | 作用 |
|------|------|
| `memory_block_list` | 可见 block 列表 |
| `memory_block_create` | 新建块（`notebook` / `kv_secret`） |
| `memory_block_update` | 改 title / description |
| `memory_block_delete_block` | 删整块（不可删 `keychain`） |
| `memory_block_entries` | entry key 列表 |
| `memory_block_get` | 读条目（secret 块脱敏） |
| `memory_block_put` | upsert（notebook 用 `body`/`title`/`tags`） |
| `memory_block_delete` | 删条目 |
| `keychain_put` / `keychain_entries` | `keychain` 别名 |

**Dashboard（只读）**：`GET /api/memory/blocks`、`GET /api/memory/blocks/:blockId/entries`（无 secret `value`）。

**外脑 tool 审计（2026-05-28）**：每次外脑 tool 调用写入 `DATA_ROOT/outer/tool-logs/<agentSid>/YYYY-MM-DD.jsonl`（`tool.call` / `tool.result`，args 脱敏）。`keychain_put` 成功后 store 读回校验，失败则工具返回错误。

**已移除（B2 解耦）**：`memory_block_bind`、`credential_ref`、awaiting 自动 vault。

内脑需要块内内容时：外脑在 IM 回合里 `memory_block_get`（或后续 notebook 可读策略）→ `set_goal` / 回复中提供必要片段，**不**复制到 `.brain/secrets/`。

---

## 5. 边界

| 内容 | Block | mem9 | skills |
|------|-------|------|--------|
| Agent 自选长期笔记 | ✅ notebook | ❌ | ❌ |
| Cookie/Token | ✅ keychain | ❌ 禁止 ingest | ❌ |
| 研究结论 | ❌ | 摘要可选 | ✅ `write_skill` |
| burst 战术 | ❌ | ❌ | ❌ `.brain/*` |

AWAITING resolve 仅写 `{ reply: text }`；是否 `memory_block_put` 由**外脑 LLM 下一轮**决定。

---

## 6. 实施梯度

| 阶段 | 交付 |
|------|------|
| B0 | Store + strategy 骨架 |
| B1 | `kv_secret` / `keychain` + entry CRUD 工具 |
| B2 | **解耦** awaiting / bind / credential_ref / executor 特殊路径 | ✅ |
| B3 | 块级 CRUD + `notebook` strategy + Dashboard | ✅ |

---

## 7. 修订

| 日期 | 说明 |
|------|------|
| 2026-05-28 | 初版 ADL |
| 2026-05-19 | 记事本定位；B2 切断 awaiting/内脑 bind 耦合 |
| 2026-05-19 | B3：notebook、块 CRUD、Dashboard `/api/memory/blocks` |
| 2026-05-19 | 存储定稿：**仅本地 vault**，不走 drive9（与 skills 分离） |

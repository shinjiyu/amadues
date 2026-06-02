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
  block_id: keychain      → strategy: kv_secret   (凭证独立保管，防长上下文丢失；非「加密传输」)
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

| strategy | 示例 block | 外脑 IM 闲聊 | 派内脑 / 内脑执行 |
|----------|------------|--------------|------------------|
| `kv_secret` | `keychain` | `get` 默认无 value（防泄露） | **明文**写入 `set_goal` → `memory.goal` → Designer `NodeInst.instruction` |
| `notebook` | （Agent 自建） | 可读摘要/全文 | 同上，按需摘录进 goal/instruction |

**keychain 语义（勿误解）**：

- **是**：把 KEY/账号密码**独立存盘**，避免在 mem9/长对话/多轮 ReAct 里丢失或反复粘贴。
- **不是**：内外脑之间的加密信道；**不是**让 baseNode 自己去 vault/浏览器「挖」凭据。

**推荐传递链**：

```text
用户给凭据 → 外脑 keychain_put（入库）
         → 外脑 keychain_get(include_value) → set_goal(goal 正文含明文账号密码)
         → 内脑 memory.goal
         → Designer commit_local_dag 时 NodeInst.instruction 写明文（从 goal/constraints 摘录）
         → baseNode 直接按 instruction 用，禁止 Edge 解密 / env 盲探
```

---

## 4. 外脑工具（`outerToolExecutor`）

| 工具 | 作用 |
|------|------|
| `memory_block_list` | 可见 block 列表 |
| `memory_block_create` | 新建块（`notebook` / `kv_secret`） |
| `memory_block_update` | 改 title / description |
| `memory_block_delete_block` | 删整块（不可删 `keychain`） |
| `memory_block_entries` | entry key 列表 |
| `memory_block_get` | 读条目；keychain 默认脱敏，`include_value=true` 取明文（用于 set_goal） |
| `memory_block_put` | upsert（notebook 用 `body`/`title`/`tags`） |
| `memory_block_delete` | 删条目 |
| `keychain_put` / `keychain_entries` | `keychain` 别名 |

**Dashboard（只读）**：`GET /api/memory/blocks`、`GET /api/memory/blocks/:blockId/entries`（无 secret `value`）。

**外脑 tool 审计（2026-05-28）**：每次外脑 tool 调用写入 `DATA_ROOT/outer/tool-logs/<agentSid>/YYYY-MM-DD.jsonl`（`tool.call` / `tool.result`，args 脱敏）。`keychain_put` 成功后 store 读回校验，失败则工具返回错误。

**已移除（B2 解耦）**：`memory_block_bind`、`credential_ref`、awaiting 自动 vault。

派内脑时：**外脑**负责 `keychain_get` → **明文写入 `set_goal`**；内脑 Designer 再 **明文写入 `instruction`**。不要把「读 vault」丢给 baseNode 当默认路径。

**内脑 keychain 只读（兜底，非主路径）**：`keychain_entries` / `keychain_get` 仅当 instruction 明确要求「从 vault key X 读取」且 goal 未带明文时使用；**禁止**内脑 `keychain_put`。见 [`DYFLOW-INNER-EXECUTOR.md`](./DYFLOW-INNER-EXECUTOR.md) §6.1c。

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
| 2026-06-02 | keychain 语义修正：独立保管 + set_goal/instruction **明文**传递；`get` 默认脱敏、`include_value` 取明文；系统块改 `kv_secret` |

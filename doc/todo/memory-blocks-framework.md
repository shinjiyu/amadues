# TODO：Memory Block 抽象（动态分块 + 策略 + LLM CRUD）

> **Status:** 待实现 · **Recorded:** 2026-05-27  
> **English:** Structured long-term agent memory as typed **blocks** (keychain = first `kv_secret` block). Uniform `memory_block_*` tools; per-block strategy for schema, ACL, and prompt redaction.

**状态**：B0 ✅ store · B1 ✅ `memory_block_*` · **B2** ✅ IM 凭证 → keychain + `credential_ref` + executor 对齐

关联：[`MEMORY-BLOCKS.md`](../structurizr/MEMORY-BLOCKS.md)（**ADL 权威**）· [`cross-agent-research-and-keychain.md`](./cross-agent-research-and-keychain.md) · [`MEMORY-STORAGE-BOUNDARY.md`](../structurizr/MEMORY-STORAGE-BOUNDARY.md) · [`executor-resolved-pendings-truncation.md`](./executor-resolved-pendings-truncation.md)（大 payload 与 bind 配合）

**不在本框架内**：跨 Agent **研究结论** → 内脑 Attributor **`write_skill`**（见 cross-agent 问题 1），不用 Block。

---

## 动机

| 需求 | 不适合 mem9 / skills | 适合 Block |
|------|---------------------|------------|
| Cookie、API Token | 语义检索、易泄露 ingest | `kv_secret` |
| 地址簿、联系人 | 非「操作步骤」 | `kv_contact`（未来） |
| 记账本条目 | 需精确 CRUD | `record_ledger`（未来） |

钥匙串 **不是** 独立子系统终点，而是 **`block_id=keychain` + `strategy=kv_secret`** 的第一个实例。

---

## 概念模型

```text
MemoryBlockRegistry
  ├── block_id: "keychain"      strategy: kv_secret
  ├── block_id: "addressbook"   strategy: kv_contact   (未来)
  └── block_id: "ledger"        strategy: record_ledger (未来)

存储（定稿，仅本地）：
  DATA_ROOT/vault/blocks/blocks-index.json
  DATA_ROOT/vault/blocks/{block_id}/entries/{key}.json
  （不走 drive9；与 /skills/shared/ 分离）
```

| 概念 | 说明 |
|------|------|
| **Block** | 命名空间 + `strategy` + ACL（哪些 agent 可读/写） |
| **Entry** | 块内一条记录（如 `weibo`、`contact:张三`） |
| **Strategy** | 校验、序列化、日志脱敏、是否允许进外脑 prompt、`bind` 到 workDir 的规则 |

### 策略族（规划）

| strategy | 典型 block | Entry 形状 | 注入内脑 |
|----------|------------|------------|----------|
| `kv_secret` | `keychain` | `{ key, kind, value, updated_at, updated_by }` | `memory_block_bind` → `.brain/secrets/{key}.json` |
| `kv_contact` | `addressbook` | `{ key, name, im, notes }` | 按需片段或 bind |
| `record_ledger` | `ledger` | `{ id, amount, category, ts, memo }` | 一般不整表注入；工具聚合 |

策略在代码侧注册：`registerBlockStrategy('kv_secret', …)`；块列表可在配置中声明（`blocks.json` 或 env）。

---

## LLM 工具面（外脑为主；内脑只读子集）

统一 CRUD，避免 `keychain_*` / `addressbook_*` 工具爆炸：

| 工具 | 作用 |
|------|------|
| `memory_block_list` | 当前 agent 可见的 block（id + strategy 说明） |
| `memory_block_entries` | `block_id` → entry key 列表（**secret 块不返回 value**） |
| `memory_block_get` | `block_id` + `key`；`kv_secret` 外脑默认仅 metadata，或禁止 get 全文 |
| `memory_block_put` | upsert；策略校验 |
| `memory_block_delete` | 删条目 |
| `memory_block_bind` | `block_id` + `keys[]` + `instance_id` → 写入 `workDir/.brain/...`，prompt 只给路径 |

内脑：读 bind 后的文件；**禁止** `write_knowledge` 写完整 Cookie。

---

## 与现有层边界

| 层 | 职责 | Block 是否替代 |
|----|------|----------------|
| `.brain/*` burst 状态 | 单次任务战术文件 | ❌ |
| mem9 `:chat` / `:tasks` | 对话摘要、软回忆 | ❌（secret 禁止 ingest） |
| drive9 `/skills/shared/` | 可复用步骤/研究蒸馏 | ❌ |
| Memory Block | 结构化长期 KV/记录 | ✅ 本 TODO |

---

## 安全（MVP）

- `kv_secret`：日志只打 `block_id` + `key` + `value.length`；禁止 mem9 `ingest` / `write_memo` 全文。
- drive9 ACL 沿用现有 key；vault 不入 git。
- 后续：at-rest 加密（`KEYCHAIN_MASTER_KEY`）、slot 级 ACL。

---

## 实施梯度

| 阶段 | 交付 |
|------|------|
| **B0** | `BlockStrategy` 接口 + `MemoryBlockStore`（drive9 + 本地降级） |
| **B1** | 实现 `kv_secret`；注册 `block_id=keychain`；5 个 `memory_block_*` 工具（外脑） |
| **B2** | `memory_block_bind` + 与 [`executor-resolved-pendings-truncation.md`](./executor-resolved-pendings-truncation.md) spill / `credential_ref` 对齐 |
| **B3** | `kv_contact`（地址簿）、配置化 `allowed_blocks` per agent |
| **B4** | `record_ledger`；Dashboard 块管理页（可选） |

[`cross-agent-research-and-keychain.md`](./cross-agent-research-and-keychain.md) 中「问题 2」的 slot 格式、`weibo` 示例、验收项在 **B1/B2** 时按本框架实现，不再单独维护一套 `keychain_*` 工具名（除非过渡期别名）。

---

## 验收

- [x] 外脑 `memory_block_put(keychain, weibo, …)` 后 vault 有条目；`memory_block_entries` 只见 key
- [x] IM 长 Cookie → awaiting resolver → `credential_ref` + bind；内脑 `read_file(".brain/secrets/weibo.json")` 得完整 value
- [ ] mem9 检索不到 Cookie 明文
- [ ] 新 strategy 仅注册 + 配置一行即可加块（无需新工具名）

---

## 修订

| 日期 | 说明 |
|------|------|
| 2026-05-27 | 初稿：Memory Block 框架；钥匙串 = 首个 `kv_secret` 块 |

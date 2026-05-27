# Memory Block 抽象（ADL 权威）

> **English:** Structured long-term agent memory as **typed blocks** with pluggable **strategies**. First block: `keychain` (`kv_secret`). Uniform outer tools `memory_block_*`; secrets never go to mem9 chat ingest.

**状态**：B0–B2 ✅（store + 工具 + IM 凭证 credential_ref）· B3+ ⏳ 更多 strategy / Dashboard

关联：[`MEMORY-STORAGE-BOUNDARY.md`](./MEMORY-STORAGE-BOUNDARY.md) · [`doc/todo/memory-blocks-framework.md`](../todo/memory-blocks-framework.md) · [`doc/todo/cross-agent-research-and-keychain.md`](../todo/cross-agent-research-and-keychain.md)

**不在 Block 内**：跨 Agent 研究结论 → 内脑 Attributor **`write_skill`** → drive9 `/skills/shared/`（见 cross-agent todo）。

---

## 1. 动机

| 需求 | mem9 / skills | Memory Block |
|------|---------------|--------------|
| Cookie、Token、API Key | 语义检索；易 ingest 泄露 | `kv_secret` / `keychain` |
| 地址簿 | 非操作步骤 | `kv_contact` / `addressbook`（未来） |
| 记账本 | 需精确 CRUD | `record_ledger` / `ledger`（未来） |

钥匙串 = **`block_id=keychain`** + **`strategy=kv_secret`**，不是独立子系统。

---

## 2. 概念

```text
MemoryBlockRegistry (配置 + 策略注册表)
  block_id: keychain      → strategy: kv_secret
  block_id: addressbook  → strategy: kv_contact   (未来)
  block_id: ledger       → strategy: record_ledger (未来)

存储（推荐）：
  drive9  /vault/blocks/{block_id}/entries/{key}.json
  降级    DATA_ROOT/vault/blocks/...
```

| 概念 | 说明 |
|------|------|
| **Block** | 命名空间 + strategy + ACL（per agent） |
| **Entry** | 块内一条记录（`weibo`、`contact:张三`） |
| **Strategy** | 校验、脱敏、是否可进外脑 prompt、`bind` 规则 |

---

## 3. 策略表（权威）

| strategy | block 示例 | Entry | 外脑 prompt | 内脑 |
|----------|------------|-------|-------------|------|
| `kv_secret` | `keychain` | `{ key, kind, value, updated_at, updated_by }` | **无 value**（仅 list keys） | `memory_block_bind` → `.brain/secrets/{key}.json` |
| `kv_contact` | `addressbook` | `{ key, name, im, notes }` | 可脱敏片段 | 按需 bind |
| `record_ledger` | `ledger` | `{ id, amount, category, ts, memo }` | 聚合统计 | 一般不整表注入 |

---

## 4. 组件 `memoryBlockStore`（L3）

| 属性 | 值 |
|------|-----|
| **职责** | Block CRUD、策略执行、`bind` 到 workDir |
| **计划路径** | `packages/server/src/outer/memory-block-store.ts`；`memory-block-strategies.ts`；工具 `packages/server/src/outer/memory-block-tools.ts` |
| **In** | `block_id` + `key` + payload；`instance_id`（bind） |
| **Out** | 条目元数据；`.brain/secrets/*.json` 或策略路径 |
| **Deps** | drive9（优先）；`innerBrainRegistry`（resolve workDir）；**禁止** mem9 ingest 明文 secret |

### 外脑工具（`outerToolExecutor` 注册）

| 工具 | 作用 |
|------|------|
| `memory_block_list` | 可见 block 列表 |
| `memory_block_entries` | key 列表（secret 无 value） |
| `memory_block_get` | 按策略返回（secret 块外脑禁全文） |
| `memory_block_put` | upsert |
| `memory_block_delete` | 删除 |
| `memory_block_bind` | `keys[]` + `instance_id` → workDir |

过渡期可保留 `keychain_*` 别名指向同一 store。

---

## 5. 边界（与 mem9 / skills / burst）

| 内容 | Block | mem9 | skills |
|------|-------|------|--------|
| Cookie/Token | ✅ keychain | ❌ 禁止 ingest | ❌ |
| 研究结论 | ❌ | 摘要可选 | ✅ `write_skill` |
| 任务进度 | ❌ | ✅ tasks/chat | ❌ |
| burst 战术 | ❌ | ❌ | ❌ `.brain/*` |

与 **resolved pending spill**（`.brain/inbound/pending-results/`）互补：大 payload 先进 spill 文件，凭证长期存 Block。

---

## 6. 安全（MVP）

- 日志：只打 `block_id` + `key` + `value.length`
- `kv_secret`：禁止 `write_memo` / smart ingest 全文
- drive9 ACL 沿用现有 key；vault 不入 git

---

## 7. 实现梯度

| 阶段 | 交付 |
|------|------|
| B0 | `BlockStrategy` 接口 + `MemoryBlockStore` 骨架 |
| B1 | `kv_secret` + `keychain` + `memory_block_*` 五工具 |
| B2 | `credential_ref` + awaiting resolver + executor 对齐 | ✅ |
| B3+ | `kv_contact`、`record_ledger`、Dashboard |

---

## 8. 测试映射

见 [`COMPONENT-TEST-MAP.md`](./COMPONENT-TEST-MAP.md) — `memoryBlockStore` 行（⏳ 用例已登记，实现后转 ✅）。

---

## 9. 修订

| 日期 | 说明 |
|------|------|
| 2026-05-28 | 初版 ADL；取代 MEMORY-STORAGE-BOUNDARY 中独立 keychain / research vault 行 |

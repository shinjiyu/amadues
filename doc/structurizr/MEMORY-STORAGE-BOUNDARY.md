# 记忆与知识存储边界（ADL ↔ 实现）

> 与 `workspace.dsl` 外脑 `knowledgeRetrieval` / `outerMemory` / `memoryBlockStore`、内脑 `write_skill` / `record_fact` 对齐。

## 存储层（勿混）

| 层 | 技术 | 路径 / API | 谁写 | 谁读 |
|----|------|------------|------|------|
| **工作区 File-as-State** | 本地磁盘 | `<workDir>/.brain/*`、`.run/*` | 内脑阶段机、外脑 `set_goal` | Controller、Dashboard |
| **执行轨 Repository** | `FilesystemRepositoryStore` | `DATA_ROOT/repository/` | 晋升 `promote-from-workspace` | **外脑** `knowledgeRetrieval`（K/S/P） |
| **外脑记忆 mem9** | HTTPS | mem9 `${sid}:chat` | `OuterMemoryStore`、`ingestInnerOutput` | `readMemoryContext` |
| **技能 drive9** | HTTPS | `/skills/shared/` | 内脑 `write_skill`、burst 结束 merge skills | `seedInnerBrainSharedContext`（含 drive9+本地池并集）、`get_skill_content` |
| **事实 drive9（完全共享）** | HTTPS | `/knowledge/shared/` | `record_fact` → `sharedFactSink` → `storeShared`（实时） | `seedDrive9FactsToMemory` → `.brain/memory.json` `fact_records`；见 [`DRIVE9-KNOWLEDGE-SHARED.md`](./DRIVE9-KNOWLEDGE-SHARED.md) |
| **节点 drive9（DyFlow，P1）** | HTTPS | `/nodes/shared/` | 内脑 `nodeAbstractor`（Creator commit auto-export）+ 外脑 `nodeDefEviction`（tombstone, P2） | Designer tool `search_and_instance` → `nodeAssembler` → `imported/*` LocalNode |
| **节点 LocalNode（DyFlow，P0）** | **本地** | `<workDir>/.brain/local_nodes/{preset,creator,imported}/*.json` | `presetSeeder` / `nodeCreatorExecutor` / `nodeAssembler` | `localNodeStore` → `designer` / `runner` |
| **DyFlow 全局 memory（P0）** | **本地** | `<workDir>/.brain/memory.json` | `runner`（node_results / last_failure）+ 外脑 set_goal seed（goal/constraints/facts） | `memoryStore` → `designer` / `baseNodeExecutor`；facts 治理 ⏳ [`FACTS-KNOWLEDGE-GOVERNANCE.md`](./FACTS-KNOWLEDGE-GOVERNANCE.md) |
| **方案参考（P0）** | **本地** | `memory.json` → `plan_references[]` | Designer `search_task_plans` | Designer 编排读；**不进** facts / drive9；见 [`TASK-PLAN-REFERENCE.md`](./TASK-PLAN-REFERENCE.md) |
| **Memory Block** | **本地** | `DATA_ROOT/vault/blocks/`（索引 + entries） | 外脑 `memory_block_*` | 外脑 CRUD；**不**上 drive9/mem9 |
| **Belief 修订索引** | 本地 JSON | `DATA_ROOT/belief/{agentSid}.json` | `memory-belief-reconcile`（用户取消/完成） | `read_memory` 折叠提示 |
| **身份映射索引** | 本地 JSON | `DATA_ROOT/identity/channel-bindings.json` | **仅** `identityBindingIndex`（经 `identityLinkService` commit 或首次 upsert） | 桥入站 `resolve`；见 [`IDENTITY-CROSS-CHANNEL.md`](./IDENTITY-CROSS-CHANNEL.md) |
| **身份 link pending** | 本地 JSON | `DATA_ROOT/identity/link-pending/` | `identityLinkService` | confirm/reject/expire |
| **IM 通道连接表** | 本地 JSON | `DATA_ROOT/channels/connections.json` | `channelConnectionRegistry` | boot + 热插；`secret_ref` → keychain |

专篇：[`MEMORY-BLOCKS.md`](./MEMORY-BLOCKS.md) · [`INNER-BRAIN-AWAITING-LIFECYCLE.md`](./INNER-BRAIN-AWAITING-LIFECYCLE.md) · [`IDENTITY-CROSS-CHANNEL.md`](./IDENTITY-CROSS-CHANNEL.md)

## 分工原则

1. **外脑对话上下文**  
   - 线程历史：Chat IR  
   - K/S/P：`knowledgeRetrieval` → **仅** repository（不走 drive9 grep）  
   - 任务/对话摘要：`outerMemory` → mem9  
   - 结构化长期 KV：**`memoryBlockStore`**（Cookie 等 **不进** mem9）
   - **跨渠道同人**：`identityBindingIndex` + `identityLinkService`（双边确认）；**禁止** LLM 直接改映射
   - **按人跨会话记忆**：`personMessageRecall`（chat-ir）——入站 sender 的 sid 别名集（bindingIndex 派生）→ 其它 thread 近期发言注入「关于此人」块；只读 Chat IR，不新增存储；见 [`IDENTITY-CROSS-CHANNEL.md`](./IDENTITY-CROSS-CHANNEL.md) §6.5

2. **内脑 burst（legacy 三件套）**  
   - 战术：`.brain/*`（BrainFS）  
   - 归档：archive sessions  
   - 软记忆：~~`write_memo`~~ 已删除；KPI 过程见 `kpiBurstOutcomeEvaluator`  
   - 可复用步骤：`write_skill` → drive9 `/skills/shared/`
   - 环境事实（legacy）：`knowledge.md` 路径已退役；DyFlow 见下条

3. **内脑 burst（DyFlow target，P0→P2 落地）**  
   - 战术节点：`localNodeStore` → `.brain/local_nodes/{preset,creator,imported}/*.json`（**保留全部** 跨 burst）  
   - 全局 memory：`memoryStore` → `.brain/memory.json`（goal/constraints/facts/last_failure/node_results/kpi_progress）  
   - 跨 burst 事实：**drive9 `/knowledge/shared/`** ↔ `memory.fact_records`（写同步 / 读 seed，无 burst 晋升）  
   - 节点共享（P1+）：`nodeAbstractor`（Creator commit auto-export → drive9 `/nodes/shared/`）+ `nodeAssembler`（drive9 → `imported/*` LocalNode）  
   - KPI 结果：burst onExit → `kpiBurstOutcomeEvaluator`（见 [`KPI-BURST-OUTCOME-EVALUATOR.md`](./KPI-BURST-OUTCOME-EVALUATOR.md)）  
   - **退役（P2）**：`write_skill` / `write_knowledge` / `write_constraint` 工具 + `.brain/skills/` / `.brain/knowledge.md` / `.brain/constraints.md` 接口被 LocalNode + memory.facts/constraints 取代；具体迁移见 [`DYFLOW-INNER-EXECUTOR.md`](./DYFLOW-INNER-EXECUTOR.md) §11

4. **禁止**  
   - 内脑/ pi-mono **import** `FilesystemRepositoryStore`（检索属外脑）  
   - `workspace-kit` **import** mem9 / drive9  
   - `outer/*`（除门面模块）**直 import** mem9/drive9 client  
   - secret 全文 **ingest** 到 mem9 或贴进 IM 长期存储  
   - **跨渠道身份**：模型或桥**绕过** `identityLinkService` 把他人 `channel_key` 绑到任意 sid（含「B 自称是 A」）  
   - **DyFlow**：baseNode / Designer prompt **直读 NodeDef 正文**（应只通过 Assembler 装配后再 ref LocalNode）  
   - **DyFlow**：任何模块**绕过 `nodeDefDrive9Store`** 直访 drive9 `/nodes/shared/`

## 代码入口

| 模块 | 文件 |
|------|------|
| 外脑装配 | `packages/server/src/index.ts` |
| mem9 门面 | `outer/outer-memory.ts` |
| **Belief 对账** | `outer/memory-belief-reconcile.ts` |
| K/S/P 检索 | `outer/knowledge-retrieval.ts` |
| **按人跨会话召回** | `chat-ir/src/runtime/person-message-recall.ts`（`knowledge-retrieval.ts` 注入） |
| **Memory Block** | `outer/memory-block-store.ts` · `outer/memory-block-tools.ts` |
| **身份映射 / 双边确认** | `chat-ir` identityBindingIndex（⏳）· `outer/identity-link-service.ts`（⏳）· [`IDENTITY-CROSS-CHANNEL.md`](./IDENTITY-CROSS-CHANNEL.md) |
| **IM 通道连接表** | `outer/channel-connection-registry.ts`（⏳） |
| 内脑写 mem9 | `openkuroneko/tools/definitions/write-memo.ts` |
| 内脑写技能（legacy） | `openkuroneko/tools/definitions/write-skill.ts` |
| drive9 技能（legacy） | `drive9/skill-drive9-store.ts` |
| drive9 共享事实读写 | `drive9/knowledge-drive9-store.ts` · `outer/knowledge-promote.ts` · `outer/agent-pool.ts` · `pi-mono/run-tick.ts` `sharedFactSink` |
| drive9 技能检索（Executor，legacy） | `openkuroneko/skills/drive9-provider.ts` |
| **DyFlow LocalNode 库（P0）** | `openkuroneko/inner-brain/local-node-store.ts` |
| **DyFlow 全局 memory（P0）** | `openkuroneko/inner-brain/memory-store.ts` |
| **方案参考检索** | `inner-brain/plan-reference-port.ts` · `outer/plan-reference-search.ts` · Designer `search_task_plans` |
| **DyFlow preset seed（P0）** | `openkuroneko/inner-brain/preset-seeder.ts` |
| **DyFlow Abstractor（P1）** | `openkuroneko/inner-brain/node-abstractor.ts` |
| **DyFlow Assembler（P1）** | `openkuroneko/inner-brain/node-assembler.ts` |
| **DyFlow drive9 NodeDef 门面（P1）** | `drive9/node-def-drive9-store.ts` |
| **DyFlow NodeDef 治理（P2）** | `outer/node-def-eviction.ts` |

## 守门

`npm run structurizr:deps` — `workspace-kit-no-cloud-memory`、`inner-no-outer-memory-modules`、`outer-no-raw-mem9-client` 等。

**DyFlow 新增（P1+）**：

- `inner-no-direct-drive9-nodes`：内脑除 `nodeAbstractor` / `nodeAssembler` / `designerToolRegistry` 外不得直访 drive9 `/nodes/shared/`
- `dyflow-no-skill-imports`（P2）：DyFlow 引擎下 `inner-brain/*` 不得 import `openkuroneko/skills/*` 或 `tools/definitions/write-skill.ts`

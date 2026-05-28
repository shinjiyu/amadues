# 记忆与知识存储边界（ADL ↔ 实现）

> 与 `workspace.dsl` 外脑 `knowledgeRetrieval` / `outerMemory` / `memoryBlockStore`、内脑 `write_memo` / `write_skill` 对齐。

## 存储层（勿混）

| 层 | 技术 | 路径 / API | 谁写 | 谁读 |
|----|------|------------|------|------|
| **工作区 File-as-State** | 本地磁盘 | `<workDir>/.brain/*`、`.run/*` | 内脑阶段机、外脑 `set_goal` | Controller、Dashboard |
| **执行轨 Repository** | `FilesystemRepositoryStore` | `DATA_ROOT/repository/` | 晋升 `promote-from-workspace` | **外脑** `knowledgeRetrieval`（K/S/P） |
| **外脑记忆 mem9** | HTTPS | mem9 `${sid}:chat` / `:tasks` | `OuterMemoryStore`、`write_memo` | `readMemoryContext` |
| **技能/共享 drive9** | HTTPS | `/skills/shared/` | 内脑 `write_skill` | `seedRelevantSkillsFromDrive9`、内脑 `get_skill_content` |
| **Memory Block** | **本地** | `DATA_ROOT/vault/blocks/`（索引 + entries） | 外脑 `memory_block_*` | 外脑 CRUD；**不**上 drive9/mem9 |
| **Belief 修订索引** | 本地 JSON | `DATA_ROOT/belief/{agentSid}.json` | `memory-belief-reconcile`（用户取消/完成） | `read_memory` 折叠提示 |

专篇：[`MEMORY-BLOCKS.md`](./MEMORY-BLOCKS.md) · [`INNER-BRAIN-AWAITING-LIFECYCLE.md`](./INNER-BRAIN-AWAITING-LIFECYCLE.md)

## 分工原则

1. **外脑对话上下文**  
   - 线程历史：Chat IR  
   - K/S/P：`knowledgeRetrieval` → **仅** repository（不走 drive9 grep）  
   - 任务/对话摘要：`outerMemory` → mem9  
   - 结构化长期 KV：**`memoryBlockStore`**（Cookie 等 **不进** mem9）

2. **内脑 burst**  
   - 战术：`.brain/*`（BrainFS）  
   - 归档：archive sessions  
   - 软记忆：`write_memo` → mem9（**非** secret）  
   - 可复用步骤/研究蒸馏：`write_skill` → drive9 `/skills/shared/`

3. **禁止**  
   - 内脑/ pi-mono **import** `FilesystemRepositoryStore`（检索属外脑）  
   - `workspace-kit` **import** mem9 / drive9  
   - `outer/*`（除门面模块）**直 import** mem9/drive9 client  
   - secret 全文 **ingest** 到 mem9 或贴进 IM 长期存储

## 代码入口

| 模块 | 文件 |
|------|------|
| 外脑装配 | `packages/server/src/index.ts` |
| mem9 门面 | `outer/outer-memory.ts` |
| **Belief 对账** | `outer/memory-belief-reconcile.ts` |
| K/S/P 检索 | `outer/knowledge-retrieval.ts` |
| **Memory Block** | `outer/memory-block-store.ts` · `outer/memory-block-tools.ts` |
| 内脑写 mem9 | `openkuroneko/tools/definitions/write-memo.ts` |
| 内脑写技能 | `openkuroneko/tools/definitions/write-skill.ts` |
| drive9 技能 | `openkuroneko/skills/drive9-provider.ts` |

## 守门

`npm run structurizr:deps` — `workspace-kit-no-cloud-memory`、`inner-no-outer-memory-modules`、`outer-no-raw-mem9-client` 等。

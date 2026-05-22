# 记忆与知识存储边界（ADL ↔ 实现）

> 与 `workspace.dsl` 外脑 `knowledgeRetrieval` / `outerMemory`、内脑工具 `write_memo` / `write_skill` 对齐。

## 三层存储（勿混）

| 层 | 技术 | 路径 / API | 谁写 | 谁读 |
|----|------|------------|------|------|
| **工作区 File-as-State** | 本地磁盘 | `<workDir>/.brain/*`、`.run/*` | 内脑阶段机、外脑 `set_goal` | Controller、Dashboard |
| **执行轨 Repository** | `FilesystemRepositoryStore` | `DATA_ROOT/repository/` 租户索引 | 晋升 `promote-from-workspace`、会话 commit | **外脑** `knowledgeRetrieval`（K/S/P 片段） |
| **外脑记忆 mem9** | HTTPS | `mem9.ai` agentId `${sid}:chat` | `OuterMemoryStore`、内脑工具 `write_memo` | **外脑** `OuterMemoryStore.readMemoryContext` |
| **技能/共享原文 drive9** | HTTPS | `drive9` `shared/skills` 等 | `SkillDrive9Store`、内脑 `write_skill` | 内脑 `query_available_skills`、外脑 AgentPool |

## 分工原则

1. **外脑对话上下文**  
   - 线程历史：Chat IR 本地 store  
   - 执行轨 K/S/P：`knowledgeRetrieval` → **仅** `FilesystemRepositoryStore`（**不**走 drive9 grep）  
   - 任务/对话摘要：`outerMemory` → mem9 + drive9 任务文件  

2. **内脑 burst**  
   - 战术状态：`.brain/*`（BrainFS）  
   - 跨 burst 归档：`archive/fs-store` sessions（可带 `kpiId` / reflexion）  
   - 给用户的重要发现：`write_memo` → mem9（不经外脑检索层）  
   - 技能登记：`write_skill` → drive9（优先）/ mem9 skill 命名空间  

3. **禁止**  
   - `openkuroneko` / `pi-mono` **npm import** `FilesystemRepositoryStore`（执行轨检索属外脑）  
   - `workspace-kit` **npm import** mem9 / drive9  
   - `outer/*`（除 `outer-memory.ts`）**直 import** `mem9-client` / `drive9-client`  

## 代码入口（单一门面）

| 模块 | 文件 |
|------|------|
| 外脑 mem9/drive9 装配 | `packages/server/src/index.ts` |
| 外脑记忆门面 | `packages/server/src/outer/outer-memory.ts` |
| 外脑 K/S/P 检索 | `packages/server/src/outer/knowledge-retrieval.ts` |
| 内脑写 mem9 | `openkuroneko/tools/definitions/write-memo.ts` |
| 内脑写技能 | `openkuroneko/tools/definitions/write-skill.ts` |
| drive9 技能列表 | `openkuroneko/skills/drive9-provider.ts` |

## 守门

`npm run structurizr:deps` 规则名：`workspace-kit-no-cloud-memory`、`inner-no-outer-memory-modules`、`outer-no-raw-mem9-client` 等。

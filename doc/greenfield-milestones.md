# 绿场实现里程碑（新代码库）

**前提**：**不在**现有 [openKuroneko](https://github.com/shinjiyu/openKuroneko) 仓库上直接改；按 `data-layer-phase1-draft.md` 与 `chat-ir-identity-design.md` **从零新建**一仓。

**代码仓库（绿场实现）**：[shinjiyu/utlraKuroneko](https://github.com/shinjiyu/utlraKuroneko)（本地目录 `hackton/utlraKuroneko`）。

### 第一目标（至 M4 + 可视化）

完成 **M0～M4**，并交付：

1. **数据层可视化**：办公室 `.run/`、`manifest`、目录树与原始 JSON 浏览。  
2. **内脑交互 UI**：设置 goal、手动 tick、重置；**工作状态可视化**（阶段、tick 数、最近动作、遥测尾部）。  

完成后由你进行联调测试；**M5 及以后**再迭代。

**原则**：接口先行 → 单机单 Agent（阶段 1）→ 再做多机同步服务（阶段 2）；聊天 IR 与身份子系统 **尽早** 与渠道解耦。

---

## 里程碑总览

| 阶段 | 代号 | 目标 |
|------|------|------|
| 0 | **Bootstrap** | 空壳仓库、工具链、核心 **TypeScript 接口包**（无业务） |
| 1 | **DataPlane-Core** | `ScopeResolver`、`WorkspaceStore`、办公室 `.run/` + `manifest` 草案 |
| 2 | **Identity-Chat-IR** | `IdentityRegistry` 最小实现 + `MessageRecord`/`ThreadRecord` 持久化 + LLM 序列化 |
| 3 | **StructuredReply** | `Reply.v1` 校验 + **ChannelRenderer** 抽象 + **MockChannel** 端到端 |
| 4 | **Inner-Runtime** | 内脑主循环（可先简于完整 Controller）：goal → 工具/LLM → 写 `.run` 与遥测 |
| 5 | **Repository-Knowledge** | `RepositoryStore` 文件/SQLite 实现、`realm/lane/visibility` 元数据、基础检索（关键词 → 预留 rerank 钩子） |
| 6 | **Outer-Orchestration** | 外脑进程：thread、**set_task / 观察内脑**（Status 轮询读）、与内脑 spawn 协议 |
| 7 | **Simple-IM** | **基于 Chat IR + 身份抽象的简易 IM 服务**（自研 HTTP/WebSocket）；不接第三方也可闭环 |
| 8 | **Hardening** | 晋升/淘汰、交互轨与执行轨分 lane、集成测试、文档与配置模板 |
| 9 | **Later** | 数据同步服务（Outbox + 中央 API），见数据层草案阶段 2 |

---

## M0 — Bootstrap

- [ ] 新建 Git 仓库；Node 20+、`pnpm`/`npm`、`typescript`、`eslint`、`vitest`。  
- [ ] Monorepo 或单包：建议 `packages/protocol`（纯类型 + Zod schema）与 `packages/runtime` 分离可选。  
- [ ] 落地 **空接口**：`DataPlane`、`WorkspaceStore`、`RepositoryStore`、`IdentityRegistry`（仅签名，抛 `NotImplemented` 或 mock）。  
- [ ] `README`：链到本目录下设计文档。

---

## M1 — DataPlane-Core（办公室）

- [ ] `ScopeRef` / `ResolvedScope` 实现（单机可先固定单 tenant）。  
- [ ] **办公室**：`<workDir>/.run/manifest.json` 与目录约定（D/K/S/P/T/M 占位）。  
- [ ] `WorkspaceStore`：读写 manifest 与任务侧小文件；**不含** LLM。  
- [ ] 单元测试：路径与 manifest 版本字段。

---

## M2 — Identity + Chat IR

- [ ] `IdentityRecord`、`sid` 生成规则（文档化）。  
- [ ] `IdentityRegistry`：内存或 SQLite；bindings 解析（可先单渠道 mock）。  
- [ ] `ThreadRecord`、`MessageRecord`、`MessagePart` 持久化。  
- [ ] **IdentityContextPack** 生成器 + **多说话者**历史序列化（§2.6）。  
- [ ] 测试：多用户 thread、SELF 与他者区分。

---

## M3 — StructuredReply + Mock Channel

- [ ] `reply.v1` JSON Schema 或 Zod；校验 `mention_sids` 均在 Pack/历史出现。  
- [ ] `ChannelRenderer`：`StructuredReply` → 纯文本/Mock wire（记录调用参数）。  
- [ ] 最小对话循环：收 Mock 入站 → 拼 Pack + 历史 → 假 LLM 或 fixture → 发 Mock。  

---

## M4 — Inner-Runtime（内脑）

- [ ] 内脑进程入口：`--work-dir`，主循环 tick。  
- [ ] 与 `WorkspaceStore`、`.run` 联动；可选 **极简 planner**（硬编码或单次 LLM）。  
- [ ] 写遥测 **T** 到 `.run/telemetry/` 或等价；**StatusBoard** 写节流快照（§11.1 备忘）。  
- [ ] 不强制首版即完整 DECOMPOSE/EXECUTE/ATTRIBUTE；可标为「v2 对齐 openKuroneko 复杂度」。

---

## M5 — RepositoryStore（执行轨共享 · 单机）

- [x] `commitSession` / `retrieve` 与 `realm`、`lane=execution`（及 `interaction` 分文件索引）。实现见 `@utlra/core` `FilesystemRepositoryStore`；HTTP：`POST /api/repository/:tenant/commit`、`POST /api/repository/:tenant/retrieve`。  
- [ ] 晋升（自动化）：任务结束从 `manifest` 推断 K/S/P —— 当前为**显式 commit API**，可后续加 `promote-from-manifest`。  
- [x] 检索：关键词粗排 + **rerank 回调占位**（`retrieve(..., rerank?)` 可接 no-op 或模型）。  

---

## M6 — Outer-Orchestration

- [x] 外脑编排：**同进程** API 加载 thread store、Identity；`POST /api/outer/roundtrip`。  
- [x] **派发内脑**：子进程 `inner-worker`（`npm run inner-worker -w @utlra/server` 或 `node dist/inner-worker.js`）跑 Pi-mono Auto burst。  
- [x] **观察**：父进程读 `InnerBrainEngine.readStatus()`（`.run/status.json`），不轮询阻塞子进程内逻辑。  
- [x] 与 StructuredReply 合并为一条回复（Mock 渠道可展示 `mock` 字段）。  

---

## M7 — Simple IM（抽象完备、实现从简）

**定位**：不依赖飞书/钉钉等第三方 IM。用 **同一套** `MessageRecord` / `ThreadRecord` / `IdentityContextPack` / `StructuredReply` 跑通「可演示、可测、可给外脑吃」的 **第一方简易会话服务**，作为所有未来渠道的 **参考实现**；第三方适配器若要做，应复用本层 API 与类型，而非另起一套。

- [x] **线程与消息持久化**：`data/chat/threads.json` 承载 `thread.v1` / `message.v1`；HTTP：`GET/POST /api/im/threads`、`GET/POST .../messages`、`GET .../pack`。  
- [x] **入站 API**：`parts[]` 校验落库；`text` + `parse_mentions: true` 时服务端 `plainTextToPartsWithMentions`；`POST /api/identity/resolve-mention`。  
- [x] **出站路径**：`reply.v1` 扩展 **`parts`**（与 `MessagePart` 同形）；`validateReplyMentions` / `renderMockChannel` 已覆盖；`demo-roundtrip` 支持 `reply_parts`。  
- [x] **身份 Pack**：`IdentityRegistry.packForThread(threadId, tenant, kind, participant_sids)` 替代仅 demo 两人。  
- [x] **多说话者拼历史进内脑 goal**：`POST /api/outer/roundtrip` 在写入本轮消息**前**取 thread 尾部消息，经 `serializeMessageForLlm` 拼前缀（`history_limit` / `UTLRA_OUTER_THREAD_HISTORY_*`）。外脑自己的 LLM 若要有，可另读同一路径。  
- [x] **多模态（路径层）**：`outer/roundtrip` 的 `parts` + 图片 data URL → `.run/outer-task-media/`；`attachment` part 引用 HTTP(S) / 相对路径。  
- [x] **上传 API**：`POST /api/im/assets`（multipart `file`）、`GET /api/im/assets/:id`；默认 `data/chat/uploads/`。  
- [x] **Pack 增强**：`GET .../pack` 在序列化 Pack 末尾附加 **`[MENTION_MAP]`**（由最近消息里的 mention part 归纳）。  
- [x] **`[ROLES]`**：`IdentityRecord.roles_in_tenant`；`serializeIdentityPack` 输出 **`[ROLES]`** 行。  
- [x] **goal 内附图语义**：`UTLRA_GOAL_VISION_ENRICH` / `enrich_goal_vision` 对本地 `![](path)` 逐张视觉摘要并追加段落（Pi-mono 仍走文本）。  
- [x] **外脑回复 LLM**：`UTLRA_OUTER_REPLY_LLM` / `outer_llm_reply` 在 burst 后用文本模型改写对用户 **StructuredReply.text**。  
- [x] **测试**：`reply`、`mention-parse`、`identity`（`[ROLES]`）。  
- [x] **IM 实验室（插件）**：`@utlra/im-plugin` + `apps/im-chat` 独立进程（`npm run dev:im`），与核心 `npm run dev` 解耦；多身份、线程、Pack、外脑 roundtrip 代理至目标 utlra API。  

**非目标（本里程碑不做）**：飞书/钉钉官方 API、OAuth、企业通讯录同步；若需要，放在 **Later** 或单独「渠道适配器」专项。

---

## M8 — Hardening

- [ ] 交互轨与执行轨 **lane** 在存储与检索上隔离验证。  
- [ ] 淘汰/tombstone 最小实现。  
- [ ] 配置：`tenant_id`、`project_id`、路径根。  
- [ ] 开发者文档：如何加一个 `MessagePart` 类型、如何扩展简易 IM 存储；第三方渠道适配器单独成章（可选）。  

---

## M9 — Later（阶段 2）

- [ ] Outbox、中央同步服务、多机 Agent；见 `data-layer-phase1-draft.md` §10–§11。  

---

## M10 — 云端记忆层（已落地）

> **定位**：替代本地文件持久化，引入两层云端存储，实现跨任务、跨 Agent 的知识自动沉淀与语义检索。

### mem9（对话与任务记忆）

- [x] `OuterMemoryStore` 完全迁移至 mem9；移除本地 fs 持久化。  
- [x] 对话日志（`${agentSid}:chat`）：每轮 fire-and-forget 写入 mem9，支持向量+BM25 混合召回。  
- [x] 任务记录（`${agentSid}:tasks`）：内存缓存保证同步读，异步写 mem9 持久化。  
- [x] mem9 通过 `agent_id` / `X-Mnemo-Agent-Id` 实现逻辑命名空间隔离，不同 Agent 数据独立。  
- [x] 发现 mem9 LLM 会改写/碎片化 `content` 字段（图谱化），**不适合存原文技能**。  

### drive9（技能原文存储）

- [x] 引入 drive9（同厂出品），存放 skills / knowledge / constraints 原文，**不经 LLM 改写**。  
- [x] `drive9-client.ts`：HTTP 封装（PUT/GET/HEAD/DELETE/grep/list），`Authorization: Bearer`。  
- [x] `skill-drive9-store.ts`：`storeShared` / `searchShared` / `listShared` / `getShared`。  
- [x] 文件路径约定：`/skills/shared/{id}.md`（共享池），未来扩展 `/knowledge/` 与 `/constraints/`。  
- [x] 文件格式：Markdown + `<!-- meta ... -->` 注释头，原文 content 不变。  
- [x] **语义搜索实测**：drive9 `grep` 使用 TiDB Cloud 向量+BM25 混合搜索，英文 query 能找到中文语义相关文件（跨语言语义对齐已验证）。  

### 技能生命周期

- [x] **写入**：内脑 `write_skill` 工具 → 本地 BrainFS + fire-and-forget 到 drive9（`DRIVE9_API_KEY` 缺失时降级 mem9）。  
- [x] **外脑 seed**（启动内脑前）：drive9 语义搜索 → 按 goal 召回 top-K 技能 → 写入 workDir `.brain/skills/`（本地化，内脑无感）。  
- [x] **外脑 merge**（任务完成后）：workDir `.brain/skills/` → drive9 `/skills/shared/`（fire-and-forget）。  
- [x] **内脑运行中**：`query_available_skills` 工具 → `Drive9SkillProvider.search()` → drive9 语义搜索 → 读取原文 → 缓存返回；`DRIVE9_API_KEY` 缺失时自动降级本地关键词匹配。  

### 分工（mem9 vs drive9）

| 数据类型 | 存储 | 原因 |
|----------|------|------|
| 对话日志 | mem9 | LLM 图谱化无所谓，需要自然语言语义召回 |
| 任务记录 | mem9 | 同上 |
| 技能（S） | **drive9** | 原文必须精确，步骤不能被 LLM 改写 |
| 知识（K）| drive9（计划中） | 同上 |
| 红线（P）| drive9（计划中） | 硬约束，不能失真 |

---

## 修订记录

| 日期 | 说明 |
|------|------|
| 2026-04-04 | 初版：绿场里程碑 M0–M9 |
| 2026-04-04 | M5/M6：RepositoryStore 与 outer roundtrip（utlra 实现落地） |
| 2026-04-04 | M7：由「真实飞书渠道」改为「基于抽象的简易 IM 服务」；第三方渠道非必选 |
| 2026-04-04 | M7 首版落地：`/api/im/*`、`reply.parts`、`packForThread`、@ 解析；roundtrip 历史拼接与上传 API 仍待办 |
| 2026-04-04 | M7：roundtrip 线程历史进 goal、`/api/im/assets`、`[MENTION_MAP]` in pack |
| 2026-04-04 | `roles_in_tenant` + `[ROLES]`；`UTLRA_GOAL_VISION_ENRICH` 附图摘要；`UTLRA_OUTER_REPLY_LLM` 外脑回复 LLM |
| 2026-04-08 | M10：云端记忆层落地（mem9 + drive9）；技能全链路语义化；分工设计文档化 |

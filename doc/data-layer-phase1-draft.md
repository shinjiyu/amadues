# 数据层设计草案

**状态**：草案（概念、算法与落地路线）  
**范围**：与 [openKuroneko](https://github.com/shinjiyu/openKuroneko) 对齐讨论后的抽象；不绑定单一实现。

---

## 1. 设计原则

1. **算法与数据分离**：内外脑、Controller 等为算法侧；落盘与库为数据侧，通过稳定接口交互。
2. **作用域优先**：任何条目的读写与检索先经过 **scope**（任务 / 项目 / 租户 / 全局），再谈相似度。
3. **产出物可枚举**：人能回答「这次留下了什么、在哪、后来去哪了」。
4. **人脑负荷**：顶层概念数量控制在 **7±2** 以内（工作记忆友好）；细分用子类型与元数据承载。
5. **工作区是「办公室」不是「独占生产车间」**：工作区用于收纳本 Agent 的任务文件与 manifest，**不**等同于能力边界或安全沙箱；`shell_exec` 等可绕过应用层路径限制，**真正的隔离靠 OS/容器/权限**。产品表述宜用 **「分配给你的工作区 / 任务资料柜」**，避免「沙箱」误导。
6. **应用层路径守卫**：若保留，定位为 **防误触**，**不是**安全边界。

---

## 2. 术语规范

| 术语 | 含义 |
|------|------|
| **Agent** | **一套部署单元**：外脑 + 其管辖的内脑池/实例（完整人机与任务链路）。本文档中 **不再** 用「agent」指内脑 alone。 |
| **内脑** | 仅指执行侧（Controller、工具循环、工作区等）。 |
| **数据中心** | 逻辑上的共享知识平面（多 Agent 可写入）；物理上可为单机目录或远端服务。 |

---

## 3. 对象模型（抽象类树 · 摘要）

- **`DataObject`**：`id`、`class`、`schemaVersion`、时间线与元数据。
- **`ScopedEntity`**：带 `ScopeRef`（tenant / pool / agent / taskInstance / thread 等组合）。
- **三条主线**（互不从属）：
  - **`WorkspaceEntity`**：Goal、Plan、Policy、Environment、ControllerState、DeliverableIndex、**`CognitiveAsset`**（抽象）→ Skill、Knowledge、ConstraintArtifact。
  - **`RepositoryEntity`**：KnowledgeSession（归档单元）、SkillPool 逻辑容器等。
  - **`InteractionEntity`**：ConversationThread、Message、ParticipantProfile。
- **`EphemeralSignal`**：InboundEnvelope、OutboundEvent、Directive、AgentStatusCard（可与 Scoped 组合）。
- **横切 Trait**：`Archivable`、`Retrievable`、`Mergeable`、`StreamAppendable` 等，避免继承爆炸。

---

## 4. 落地模块接口（草案摘要）

算法侧只依赖 **`DataPlane`** 门面，由实现解析路径：

| 模块 | 职责 | 当前实现 |
|------|------|----------|
| `ScopeResolver` | `ScopeRef` → 存储根与能力 | 本地路径解析（`DATA_ROOT`） |
| `WorkspaceStore` | 工作区文档型实体读写 | `WorkspaceStore`（文件系统） |
| `SignalStream` | input / output / directives 等追加流 | — |
| `StatusBoard` | AgentStatusCard | `.run/status.json` |
| `RepositoryStore` | 全局（或分层）知识会话的 commit / search | `FilesystemRepositoryStore` |
| `SkillPoolStore` | 技能池 seed / merge | **`SkillDrive9Store`**（drive9 `/skills/shared/`）；降级 `SkillMemoryStore`（mem9） |
| `InteractionStore` | Thread / User | `ThreadStore`（JSON 文件） |
| `SemanticMemoryStore` | 对话/任务语义记忆 | **`OuterMemoryStore`**（mem9，对话日志+任务记录） |
| `StructuredLogSink`（可选） | 审计日志 | — |

详见对话中展开的 TypeScript 形接口；实现可替换为文件 / SQLite / 对象存储 / 远端 API。

**阶段 1** 应固定 **`RepositoryStore` 的接口形状** 与写入元数据（含 `realm`、`written_by`、`client_mutation_id` 等），便于 **阶段 2** 换为「远端 + Outbox」实现而 **不改业务语义**。

---

## 5. 任务产出物体系（六类 · 4+2）

顶层类型建议固定为 **6 类**（不超过 7），文档第一层次称 **「任务产出物」**。

| 代号 | 名称 | 定义 | 硬/软 | 典型消费者 |
|------|------|------|------|------------|
| **D** | 交付物 | 用户要的文件制品 | 流程/验收 | 人、外脑附件、COMPLETE |
| **K** | 知识条 | 事实与结论（陈述性） | **软** | 检索注入、归档 |
| **S** | 技能条 | 做法与步骤（程序性） | **软** | 技能池、渐进披露 |
| **P** | 策略条（含红线） | 必须/禁止/优先 | **硬（相对）** | 规划与执行强制注入或校验 |
| **T** | 遥测/轨迹 | 工具调用、日志、状态快照 | 内部 | 排障、审计、归因输入 |
| **M** | 对外消息 | BLOCK / COMPLETE / PROGRESS 等 | 通道 | PushLoop、频道 |

### 5.1 术语与生效机制（要点）

- **知识条（K）**：「是什么」；**检索驱动**，未注入则不参与当轮推理。
- **技能条（S）**：「怎么做」；**按需读取**，渐进披露。
- **策略条（P）**：「必须怎样」；**不应仅靠检索**；应在 Decomposer / Executor 前 **强制出现** 或校验；撤销需可审计，避免静默失效。

### 5.2 可理解的落点（建议约定）

每个任务实例建议有统一根：**`<workDir>/.run/`**（**办公室**），并含 **`manifest.json`** 索引六类产出及 **promotions**（晋升到共享库、技能池等）。  
（与当前 openKuroneko 分散在 `.brain`、`tempDir`、家目录的实现可渐进映射。）

---

## 6. 知识分层、共享与隔离

### 6.1 任务局部 vs 组织/项目共享（逻辑层）

**概念上必须区分**（本质是 **scope + 生命周期**）：

| 层 | 用途 | 生命周期（原则） |
|----|------|------------------|
| **局部（任务）** | 当前 run 的高相关事实与结论 | 任务结束：丢弃 / 仅快照 / **晋升** |
| **共享库（项目/组织）** | 跨任务、跨内脑复用 | 长期；**替代链、陈旧降权、tombstone** |

**实现上** 全局与局部 **可不做物理隔离**：同一存储 + 强制 **`scope` / `realm` 元数据** 即可。

**策略条（P）** 同样区分 **任务局部** 与 **组织/项目级**；晋升与撤销规则 **严于 K**。

### 6.2 两条知识轨（解决「多 Agent 重复踩坑」）

| 轨 | 内容 | 跨 Agent 默认 |
|----|------|----------------|
| **交互轨（聊天/对话知识）** | Thread 历史、用户偏好、语气、未脱敏闲聊 | **不共享**（跟 Agent 或 thread 绑定） |
| **执行轨（客观知识）** | 内脑归因产生的 **K**、可复用 **S**、审慎晋升的 **P** | **在项目内共享**（避免同一错误每个 Agent 犯一次） |

**客观**指：脱离「当时跟谁说了什么」仍成立的事实、步骤、根因结论；**不**把逐字聊天记录当执行轨默认内容。

**注意**：执行日志、栈追踪中可能含隐私 → 进共享库前须 **脱敏 / 晋升闸门**。

### 6.3 外脑（不同 Agent）之间是否隔离

- **逻辑隔离：需要**。不同 Agent 常对应不同租户/产品线/人群，**默认检索与归档必须带 Agent 或租户边界**，避免串库。
- **物理隔离：可选**（分 volume / 分库 vs 单库 + `realm` 前缀）。

### 6.4 推荐命名空间层次（检索顺序示例）

`任务局部 K` → **`Agent` 私有（若有）** → **`project` 执行轨共享** →（可选）更广组织库。

交互轨 **不** 进入共享执行轨的默认检索路径。

---

## 7. 共享数据中心与可见性管理

当多个 Agent 写入 **同一数据中心** 时，需要 **可见性管理**，而非仅靠藏路径。

建议每条记录至少携带：

| 维度 | 含义 | 示例 |
|------|------|------|
| **Realm（分区）** | 数据归属哪个项目/租户/环境 | `project_id`、`tenant_id`；检索 **必须先带 realm** |
| **Lane（车道）** | 数据性质 | `execution`（执行客观知识）vs `interaction`（对话轨，默认不进共享检索） |
| **Visibility** | 分区内谁可读 | `project_read`、`agent_only`、`restricted`（角色/白名单） |
| **血缘** | `written_by_agent_id`、`source_run_id` 等 | 审计与撤销 |

**写入策略（示例）**：Agent 默认仅可向本 `project` + `lane=execution` **创建**；**晋升**时打上 `realm` 与 visibility 模板；管理面可调整 visibility、tombstone、合并重复条。

**接口形态**：`ingest(Record, credentials)`，由数据中心根据调用方身份解析允许的 `realm` 与 visibility **上限**。

---

## 8. 内脑 → 共享知识库检索（信噪比）

**目标**：宁可少注入，不可低质注入。

推荐 **多阶段流水线**（在 **realm / lane / visibility** **硬过滤** 之后）：

1. **Query 理解**：关键词 + 短语/实体 + 可选意图标签 + 可选负向降权词。
2. **多路召回**：关键词倒排 + 向量 + 同项目近期 +（可选）血缘。
3. **粗排**：关键词相似度、向量相似度、项目匹配、**时间衰减** 加权。
4. **重排（Rerank）**：交叉编码器或小模型对 `(q, snippet)` 打分——**信噪比关键杠杆**。
5. **多样性**：MMR / 聚类去重，避免 Top-K 全为同义重复。
6. **预算打包**：总 token/字符上限 + 分类型上限（constraints / skills / knowledge）。
7. **拒答门**：最高分低于阈值则 **不注入**。

**注入顺序**：**本任务 `active_local` 的 K** 优先于 **共享库检索结果**，并配固定免责声明句。

**与 openKuroneko 现状**：当前 FilesystemStore 以 **关键词 + 分类型阈值** 为主；演进时应增加 **realm/lane/visibility、rerank、多样性、拒答门**。

---

## 9. 作用域管理：晋升与淘汰

### 9.1 条目状态（逻辑）

`draft` → `active_local` → `promoted` / `archived` → `tombstone` →（可选）`purged`。

### 9.2 晋升（Promotion）

- **触发**：任务成功闭环、显式标记、归因建议、人工审批（敏感域）。
- **闸门**：去重、敏感信息、范围裁剪、**tenant/project/visibility**、**血缘**（`source_run_id` 等）。

### 9.3 淘汰（Retirement）

- **局部**：默认激进（保留期后可 purged）；未晋升可只进快照。
- **共享库**：默认保守（**supersedes**、**archived**、**tombstone**）；物理删除仅合规场景。

### 9.4 建议每条携带的最小元数据

`scope`、`realm`、`lane`、`visibility`、`run_id`、`local_id`、`global_id`、`status`、`promoted_at`、`supersedes`、`valid_until`、`sensitivity`、`lineage`。

---

## 10. 多机部署与数据同步

多个 Agent 可能部署在 **不同机器** 上，共享数据中心通常 **远端为真源**。

### 10.1 数据分类与落地偏好

| 类型 | 多机时的偏好 |
|------|----------------|
| **办公室 / 任务本地**（`.run`、大交付物、临时遥测） | **以本机为主**；共享库多存 **摘要、指针、小片段** |
| **项目共享执行轨** | **中央为真源**；各机可 **Outbox + 缓存** |

### 10.2 写入模式

- **在线直写**：同步调用中央 API；需 **幂等**（`client_mutation_id` / 去重键）。
- **本地 Outbox + 异步同步**：先写 **本地 durable 队列**，后台 **at-least-once** 推送，成功再 ack；需处理 **重复投递** 与 **最终一致**（他机短暂搜不到新条）。

### 10.3 读路径

- **本地缓存**（LRU/磁盘）：降低延迟与读压；**写仍以中央为准**（或与 Outbox 组合）。

### 10.4 冲突

执行轨以 **append** 为主；同条修订需 **`revision` / 向量时钟 / LWW + 审计** 之一；协议中写明可接受的 **可见延迟**。

---

## 11. 分阶段实施

### 阶段 1：单 Agent、单机数据落地

**目标**：一个 Agent 在一台机器上 **自洽**（办公室 + 本地或单机共享库 + 检索 + 晋升）。

**包含**：`.run/` + manifest；交互轨与执行轨 **逻辑分 lane**（可先同库不同前缀）；`RepositoryStore` 的 **接口固定**，实现为 **本地文件或单机 SQLite**；写入带 **`realm`（可先固定单 project）、`written_by`、`client_mutation_id`** 等钩子。

**不做**：跨机同步、多 Writer 复杂冲突（可先单写或 LWW）。

**物理细节待裁定**：目录命名、索引文件、WORM、崩溃恢复（临时目录 + rename）等。

### 阶段 2：数据同步服务

**目标**：多机多 Agent 共用 **中央数据中心**；Agent 侧 **Outbox + 异步同步**；读侧 **缓存/失效**。

**包含**：中央 REST/gRPC + 鉴权；按 **realm + visibility** 过滤；统一建索引（关键词/向量）；与阶段 1 **同一套 `RepositoryStore` 抽象** 的远端 + Outbox 适配实现。

阶段 1 完成后应修订 §4、§11 与实现说明为「最终实现」。

### 11.1 后续扩展（备忘）：内脑可观测性

**痛点**：内脑执行期间，外脑难以直观理解「正在做什么」。  
**方向**：在不影响内脑主循环的前提下，提供 **快速、只读** 的观察机制（与 §4 `StatusBoard`、§5 遥测 **T** 自然衔接）：例如节流写入的 **状态摘要**（当前模式/里程碑/最近工具标签）、可选 **事件流**（采样或环形缓冲）；外脑 **轮询或订阅**，协议上仍走统一 `ScopeRef` / `taskInstance`，落地层扩展字段即可，**不必**现在定稿。

---

## 12. openKuroneko 现状映射（便于迁移）

| 草案概念 | 现状位置（约） |
|----------|----------------|
| 工作区状态 | `workDir/.brain/*`、`tempDir` |
| 全局归档库 | `~/.openkuroneko/knowledge-base`（默认无 tenant / 外脑过滤） |
| 技能池 | `<obDir>/agent-pool/.brain` |
| 语义记忆 | Mem0，`user_id = agentId` |
| 对话数据 | 外脑 `ThreadStore` / `UserStore` |

---

## 14. 云端记忆层落地（2026-04-08 实际实现）

> 本节记录阶段 1 完成后引入的**云端语义存储**，对应 §4 `SemanticMemoryStore` 与 `SkillPoolStore` 的落地实现。

### 14.1 双层存储架构

| 层 | 产品 | 适合数据 | 原因 |
|----|------|----------|------|
| **mem9** | mem9.ai（TiDB + 向量） | 对话日志（M）、任务记录 | LLM 图谱化可接受；自然语言语义召回 |
| **drive9** | drive9.ai（同厂出品） | 技能（S）、知识（K）、红线（P） | 原文存储不经 LLM 改写；内置 vector+BM25 语义搜索 |

### 14.2 mem9 实现细节

- **命名空间隔离**：`agent_id` / `X-Mnemo-Agent-Id` header 区分不同 Agent；格式为 `${agentSid}:chat`（对话）/ `${agentSid}:tasks`（任务）。
- **写入**：fire-and-forget（异步），不阻塞主流程。
- **读取**：tasks 有内存缓存保证同步读；chat 直接 await。
- **重要发现**：mem9 后端 LLM 会将 `content` 字段图谱化（碎片化为第三方陈述句），原始结构化内容（如技能步骤）经改写后不可用。**因此 skills 不走 mem9**。

### 14.3 drive9 实现细节

**HTTP API**（`Authorization: Bearer {DRIVE9_API_KEY}`）：

| 操作 | HTTP | 示例 |
|------|------|------|
| 写文件 | `PUT /v1/fs/{path}` | 上传技能 Markdown |
| 读文件 | `GET /v1/fs/{path}` | 下载技能原文 |
| 列目录 | `GET /v1/fs/{path}/?list=1` | 列 `/skills/shared/` |
| 语义搜索 | `GET /v1/fs/{prefix}/?grep={q}&limit={n}` | 返回 `[{path, name, score}]` |
| 存在检查 | `HEAD /v1/fs/{path}` | 状态码 200/404 |
| 零拷贝复制 | `POST /v1/fs/{dst}?copy` + `X-Dat9-Copy-Source` | 无需重传数据 |

**文件格式**（`/skills/shared/{id}.md`）：

```markdown
# 技能标题

<!-- meta
id: s-xxxx-yyy
category: shell
tags: git, remote, 验证
ts: 2026-04-08T...
source: agent-sid
-->

场景：...
步骤：
1. ...
```

**语义搜索实测**：英文 query → 中文语义相关文件（跨语言）；分数统一偏低（0.03 量级）但召回准确，被排除的文件确实不相关。

### 14.4 技能全链路

```
内脑 write_skill 工具
  ─→ 本地 BrainFS（workDir/.brain/skills/）    ← 立即可用
  ─→ drive9 /skills/shared/{id}.md              ← fire-and-forget

外脑 execSetGoal（启动内脑前）
  ─→ drive9.grep(goal, topK=5)                  ← 语义搜索
  ─→ workDir/.brain/skills/ 写本地              ← 内脑无感知 drive9

内脑 query_available_skills 工具
  ─→ Drive9SkillProvider.search(query)          ← 语义搜索（HTTP）
  ─→ 读各文件原文 → 内存缓存
  ─→ 返回原始步骤给 LLM

外脑 onExit（任务完成后）
  ─→ mergeWorkDirSkillsToDrive9()               ← fire-and-forget
```

**降级链**：`DRIVE9_API_KEY` 未设置时 → mem9（rawContent 保留原文）→ 本地关键词匹配。

### 14.5 配置

申请步骤与官方链接：**[`deploy/mem9-drive9-credentials.md`](./deploy/mem9-drive9-credentials.md)**

| 环境变量 | 用途 |
|----------|------|
| `DRIVE9_API_KEY` | drive9 鉴权（`dat9_...` 格式） |
| `DRIVE9_SERVER` | API 地址（默认 `https://api.drive9.ai`） |
| `MEM9_API_KEY` | mem9 鉴权（对话/任务记忆） |

### 14.6 待扩展

- **知识条（K）** 迁移至 drive9：`/knowledge/{agentSid}/{id}.md`  
- **红线（P）** 迁移至 drive9：`/constraints/{agentSid}/{id}.md`  
- **drive9 浏览器**：dashboard 接 `/api/skills` 接口，人工可在 Web UI 查看/搜索技能库  

---

## 13. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-04-04 | 阶段一草案首版：概念、产出物、scope/生命周期、检索流水线、落地接口摘要 |
| 2026-04-04 | 增补：术语 Agent/内脑；办公室隐喻与工作区边界；知识双轨与项目共享；外脑隔离；数据中心可见性（realm/lane/visibility）；多机 Outbox/缓存；分两阶段实施 |
| 2026-04-04 | §11.1 备忘：内脑可观测性（轻量 StatusBoard/遥测扩展，后议） |
| 2026-04-08 | §14 新增：云端记忆层落地（mem9+drive9 双层架构、HTTP API、技能全链路、实测结果） |

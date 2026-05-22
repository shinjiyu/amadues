# 内外脑交互与聊天协议（实现对照）

本文档把 **设计**（`chat-ir-identity-design.md`、`data-layer-phase1-draft.md`）与 **utlraKuroneko 当前实现** 对齐说明，并区分 **正式编排流程** 与 **调试用手动操作**。

---

## 1. 外脑聊天协议（Chat IR + StructuredReply）

| 概念 | 设计位置 | 实现状态 |
|------|----------|----------|
| `MessageRecord`（`message.v1`）、`ThreadRecord` | `chat-ir-identity-design.md` §3–4 | `@utlra/chat-ir` Zod schema + 持久化于 `data/chat/threads.json`（由 API 读写） |
| `IdentityContextPack`、多说话者序列化 | 同文档 §2、§4 | `IdentityRegistry` + `serializeIdentityPack` / `serializeMessageForLlm` |
| `StructuredReply`（`reply.v1`）、`mention_sids` 校验 | 同文档 §5 | `StructuredReplySchema`、`validateReplyMentions` |
| Mock 渠道出站 | 同文档 | `renderMockChannel`；`POST /api/chat/demo-roundtrip` 演示 |
| **完备抽象的简易 IM**（thread/消息 CRUD、`parts[]`、多说话者、与 roundtrip 串联） | M7（见 `greenfield-milestones.md` §M7） | **进行中 / 未闭环**（当前仅有类型与零散演示） |
| 第三方 IM（飞书等）官方 API 适配 | Later / 可选专项 | **非 M7 必选** |

**结论**：**IR 与身份的类型与序列化已在 core**；M7 的目标是 **第一方简易 IM 服务** 把抽象用满，而不是先接飞书。

---

## 2. 外脑 → 内脑（派发与观察）

| 能力 | 设计意图 | 实现 |
|------|----------|------|
| 设目标 / 任务 | 外脑写 goal、触发执行 | `POST /api/inner/:ws/goal`、`InnerBrainEngine.setGoal`（权威 `.brain/goal.md`） |
| **正式：一轮外脑任务** | thread 记账 + goal + 子进程 burst | `POST /api/outer/roundtrip`：`text` 或 `parts[]`（含图片 data URL → 落盘进 goal，见 §7） |
| 执行一段内脑（内省 / Dashboard） | 同进程 tick / 调试 | `POST /api/inner/:ws/pi-tick`、`pi-auto` |
| 观察状态 | 只读 | `GET /api/inner/:ws/status`、`GET /api/outer/inner-status/:ws` |

### 2.1 IM 插件 ↔ 外脑（适配协议）

渠道桥（`DiscordChannel` 等）在 chat IR 持久化消息后**不直接走 HTTP**：而是通过注入的 `onAgentMessage` callback 直接调用 OuterBrain.handleInbound，与 `runOuterRoundtrip` 共用同一 agent 进程内的 `threads.json` / `identities.json`。如果**外部系统**想触发一次 roundtrip（例如离线测试或人类直接 POST），仍可走 `POST /api/outer/roundtrip` HTTP 入口，并将 `user_message_persisted: true` 与 `text`/`parts` 二选一。

---

## 3. 内脑 → 外脑（完成、晋升、休眠）

数据层草案（`data-layer-phase1-draft.md`）约定执行轨 **K/S/P** 进入共享库；本仓库 **RepositoryStore** 对应「执行轨 / 交互轨」索引。

### 3.1 自动晋升（manifest → Repository）

- **来源**：办公室 `manifest.json` 的 `outcomes.knowledge` / `skills` / `policy` / `deliverables`（路径相对于 workspace）。
- **动作**：将指向的文件内容读入（有长度上限），写入 **执行轨** `RepositoryStore` 的一条 `commitSession`。
- **API**：`POST /api/repository/:tenant/promote-from-workspace/:ws`

### 3.2 任务完成后：先晋升，再关闭内脑（推荐顺序）

内脑在 **目标完成** 时常进入 `BLOCKED`（例如 blockedReason 含「目标已完成」）。检测逻辑与 pi-tick 返回的 `suggestPromoteShutdown` 一致（实现：`suggestGoalCompleteForShutdown`）。

1. **晋升**：把当前任务在 manifest 中登记的产出写入共享知识库。
2. **关闭内脑**：将 Pi-mono 控制器置为 `SLEEPING`（`brainShutdown`，不删 goal/里程碑文件）。

**合并 API（内脑命名空间，与 Dashboard 调试按钮一致）**：`POST /api/inner/:ws/promote-and-shutdown`  
body：`{ "tenant_id": "default", "realm": "workspace:default" }`（均可选）

### 3.3 与「完全清空」的区别

| 操作 | 作用 |
|------|------|
| `promote-and-shutdown` / 外脑 `shutdown`（`promote_manifest: true`） | 写入 Repository + 控制器休眠；**保留** workspace 内脑文件与 manifest |
| `fullResetForRetest`（完全清空） | 删除 goal、清空 `.brain` 核心文件等；用于**重新测试** |

### 3.4 产物回传（`inner-brain-deliverables.v1`）

**关键事实**：§3.1 的 manifest 晋升与本节的"产物回传"是**两件独立的事**——前者把产物送进**长期知识库**（`RepositoryStore`），后者把产物送回**当前对话的用户**（chat IR `attachment`）。

| 规则 | 简述 | 落点 |
|---|---|---|
| 内脑显式登记产物 | `register_deliverable(relative_path)` 工具；**未登记不发** | `<tempDir>/deliverables.json` |
| 内→外通道 | `COMPLETE` 事件携带 `deliverables: string[]` 字段 | `<workDir>/.run/pi-mono/output` |
| 系统层吸收 | 外脑 `onExit(DONE)` 分支唯一负责把路径转 `asset:<uuid>`（不重复，不外扫） | `ChatAssetStore.save` |
| LLM 可见性 | `inner-status.v1` 扩展 `deliverables: DeliverableAsset[]` 字段 | `<workDir>/.run/status.json` |
| LLM 主动 attach | `StructuredReply.attach_asset_ids: string[]` 运行时展开为 attachment parts；`send_file` 工具参数改为 `asset_ids` | reply.v1 |
| 校验 | LLM 引用的 asset_id 必须能在 status / 入站 / pack 中找到，否则静默剔除 | R6.4 / R6.5 |

**完整条文**：见独立子协议 [`doc/protocols/inner-brain-deliverables.md`](./protocols/inner-brain-deliverables.md)。

> ⚠️ **历史行为已禁用**：`listDeliverables(workDir)` 全目录扫描 + `text` 拼路径字符串的旧实现（v1 之前）**不再合规**，只有内脑显式登记的文件才会被回传，回传必须用 `MessagePart.attachment`，不能用 text 字符串假装。

### 3.5 BLOCK（Human-in-the-loop）与 KPI / 反思

| 步骤 | 行为 |
|------|------|
| 归因器 | 缺登录/凭据/人类数据 → `CONTROL: BLOCK`（见 `attributor.ts`） |
| 内脑 | 写 JSON `BLOCK` 输出 → `mode=BLOCKED`；同 tick `safeArchive(trigger=BLOCK)` |
| 等待 | 无 `input` / `[BLOCK解封]` directive 时 `hadWork=false` → 子进程 **idle 退出** |
| 外脑 `onExit` | 若末事件为 BLOCK → 注册表 `status=BLOCKED` + IM 通知用户 |
| 解封 | 用户回复 → 外脑 `send_directive`（`[BLOCK解封] 用户回复：…`）→ 同一 burst 继续 |

**与 KPI 的关系**（实现细节与改造清单见 [`packages/server/docs/kpi-reflexion-design.md`](../packages/server/docs/kpi-reflexion-design.md)）：

- BLOCK **不阻止** burst 退出后的 `processBurstExitForKpi`（idle streak / meta reflexion burst）。
- 若 BLOCK 前已 `register_deliverable`，当前逻辑可能 **resetIdle**，导致「卡住」计数涨不上去——与「探索报告式 deliverable」有关。
- Per-burst `runReflexion` 应在 `safeArchive` 内执行并写 `reflexion.json`；**截至 2026-05-16 尚未接入**，故 `reflexionTrail` 常为空。
- Meta reflexion burst 由 `UTLRA_KPI_STUCK_THRESHOLD`（默认 3）触发，与外脑是否 `send_directive` 无关。

> **架构演进预告**：BLOCK / HITL 在后续将退化为 [`agent-data-state-machine.md`](./agent-data-state-machine.md) §5.2 描述的 `pendings.json[kind=ask_user]` 实例（统一收纳所有"等外部"的语义）。本节描述的是过渡期实现。

---

## 4. 正式编排规则：外脑启动内脑，并应能关闭内脑

**原则**：生产或集成测试应以 **外脑 API** 为边界；Dashboard 上的表格与「晋升并关闭」按钮仅作 **调试**。

### 4.1 启动内脑（已有）

`POST /api/outer/roundtrip`：追加 thread 消息 → `setGoal(text)` → 子进程 `inner-worker` 跑 Pi-mono Auto（burst）→ 返回 `StructuredReply` 与 `lifecycle` 字段。

### 4.2 burst 结束后：是否自动「晋升 + 关闭」

由 **`AfterBurstPolicy`** 控制（实现：`packages/server/src/outer/inner-lifecycle.ts`）：

| 策略值 | 含义 |
|--------|------|
| `none`（默认） | burst 结束后不自动晋升、不自动关闭；若磁盘上已出现「目标已完成」，回复文案中会 **提示** 可配置策略。 |
| `promote_and_shutdown_if_complete` | 若 `suggestGoalCompleteForShutdown(workDir)` 为真，则顺序执行 **manifest → Repository** 与 **brainShutdown**（与 `promote-and-shutdown` 相同）。 |

**配置方式**（二选一或组合）：

- 环境变量：`UTLRA_OUTER_AFTER_BURST=promote_and_shutdown_if_complete`（或 `1` / `true`）。
- 单次请求：`POST /api/outer/roundtrip` body 中 `after_burst: "promote_and_shutdown_if_complete"`（会覆盖默认；传 `inherit` 则读环境变量）。

响应中的 **`lifecycle`** 含：`afterBurstPolicy`、`goalCompleteSuggested`、`promoteShutdownApplied`、`promoted`（若执行了晋升）。

### 4.3 外脑主动关闭内脑（不依赖 burst）

`POST /api/outer/workspace/:ws/shutdown`

body：

| 字段 | 含义 |
|------|------|
| `promote_manifest: true` | 正式收尾：先晋升再休眠（等价于 `POST /api/inner/:ws/promote-and-shutdown`）。 |
| 省略或 `false` | 仅 `brainShutdown`（等价于 `POST /api/inner/:ws/brain-shutdown`）。 |
| `tenant_id` / `realm` | 可选，与晋升 API 一致。 |

响应：`mode` 为 `promote_then_sleep` 或 `sleep_only`。

---

## 5. 调试：知识库可视化

- **API**：`GET /api/repository/:tenant/records?lane=&limit=`
- **UI**：控制台 **数据层** 中「[调试] 执行轨知识库」表格，仅用于确认索引是否写入；**不作为**正式运维界面。

---

## 6. 后续（未实现）

- **`[POLICY]`** 租户红线与执行轨策略对齐（设计稿 §2.5）。  
- **外脑 LLM 输出结构化 JSON**：当前 `UTLRA_OUTER_REPLY_LLM` 生成**自然语言**用户回复；若需机器可解析的 `StructuredReply` 全字段，可改为 JSON mode + Zod。  
- 内脑 `all.complete` **事件推送**（Webhook / 队列）；当前仍为 burst 后策略与轮询。  
- 从 `.brain/knowledge.md` 自动切片晋升（无 manifest 条目时）。  
- 第三方 `ChannelRenderer`（飞书 / 钉钉 wire）。  

**已落地**：`roles_in_tenant` + Pack **`[ROLES]`**；`UTLRA_GOAL_VISION_ENRICH`（goal 内本地图 → 视觉摘要）；`UTLRA_OUTER_REPLY_LLM`（roundtrip 后改写对用户回复）；线程历史进 goal、**`/api/im/assets`**。  

---

## 7. 完备性核对：IM 抽象、多模态对齐、外脑观察内脑

### 7.1 外脑 IM 抽象是否「完备」

| 维度 | 状态 | 说明 |
|------|------|------|
| **类型（IR）** | 较完备 | `MessagePart`、`ThreadRecord`、`reply.v1` 含可选 **`parts`**（与入站同形）。 |
| **持久化与 API** | **已落地 v1** | `GET/POST /api/im/threads`、`GET/POST .../messages`、`GET .../pack`；`threads.json` 内校验 `thread.v1`/`message.v1`。 |
| **出站多模态** | **已支持** | `StructuredReply.parts` + `collectMentionSidsFromReply` + `renderMockChannel`；`POST /api/chat/demo-roundtrip` 可传 `reply_parts`。 |
| **身份** | 增强 | `resolveMentionToken`、`packForThread`；`roles_in_tenant` + **`[ROLES]`**；`plainTextToPartsWithMentions`；`POST /api/identity/resolve-mention`。 |
| **余量** | 待办 | **`[POLICY]`**、推送、外脑 LLM 结构化 JSON。 |

**结论**：**简易 IM + 出站 parts + 上传 + 线程历史进 goal + 可选外脑/视觉增强** 已贯通；产品级差距主要在 **策略块、推送、强类型 LLM 输出**。

### 7.2 外脑与内脑「多模态」是否对齐

| 路径 | 能力 |
|------|------|
| **内脑** `POST /api/inner/:ws/llm-step` | 支持 **附图**（`imageBase64` + `mimeType`）→ 智谱多模态；**与 goal.md 独立**。 |
| **内脑 Pi-mono** | Decomposer / Executor 将 **goal.md 当纯文本** 注入 LLM；**不会**自动把 `![](.run/outer-task-media/…)` 当 vision 请求解析。 |
| **外脑** `POST /api/outer/roundtrip` | 现已支持 **`parts[]`**：`attachment` + `data:image/...;base64,...` 写入 workspace **`.run/outer-task-media/`**，goal.md 中为 **Markdown 图片相对路径**。内脑侧 **先以文本+路径形式** 看见任务；若需「看图执行」，需后续：外脑先 **视觉摘要进 goal**、或 **扩展 Pi-mono 读图**、或 **工具链读文件送多模态**。 |

**结论**：**存储与任务描述已可对齐到同一 workspace**；**感知对齐（LLM 真看图）尚未自动完成**，属于下一阶段产品决策。

### 7.3 外脑能否「实时、深入」检查内脑工作状态

| 能力 | API | 说明 |
|------|-----|------|
| 聚合状态 | `GET /api/outer/inner-status/:ws`、`GET /api/inner/:ws/status` | 同一套 `inner-status.v1`（阶段、tick、最近动作、goal 摘要等）。 |
| 遥测 | `GET /api/inner/:ws/telemetry` | `.run/telemetry/trace.jsonl` 尾部。 |
| **深入快照** | `GET /api/inner/:ws/brain-inspector` | `.brain` 控制器模式、goal 片段、execution-context 摘要、Pi 日志中的归因等（`buildBrainInspectorPayload`）。 |
| 原始 Pi 日志 | `GET /api/inner/:ws/pi-logs` | JSONL 调试事件。 |

**「实时」**：当前为 **HTTP 轮询**（如 Dashboard 2s 拉 status / inspector），**无** WebSocket/SSE 推送；子进程 burst 期间父进程仍可读磁盘状态，但**不会**比磁盘更新更快。

**结论**：**可以深入检查**（inspector + 日志 + status）；**实时性 = 轮询延迟 + 磁盘写入频率**，不是事件流。

---

## 修订记录

| 日期 | 说明 |
|------|------|
| 2026-04-04 | 初版：协议对照、晋升+关闭内脑、与绿场里程碑 M5/M6 对齐 |
| 2026-04-04 | 正式编排：`UTLRA_OUTER_AFTER_BURST`、`roundtrip.lifecycle`、外脑 `shutdown`；可视化标为调试 |
| 2026-04-04 | M7 定义对齐：简易 IM（抽象完备）优先；第三方渠道非必选 |
| 2026-04-04 | `[ROLES]`、goal 附图视觉摘要、外脑回复 LLM；§6/§7.1 更新 |
| 2026-04-04 | §7：IM/多模态/观察内脑完备性核对；roundtrip 支持 `parts` + 图片落盘 |
| 2026-04-05 | §2.1：引用 `im-outer-adapter-protocol.md`（IM 与外脑对接契约） |
| 2026-05-11 | §3.4：新增产物回传子协议（`inner-brain-deliverables.v1`）；废弃 `listDeliverables` 全扫与 `send_file` 旧签名；收紧 `attach_asset_ids` 语义 |
| 2026-05-16 | §3.5：BLOCK（HITL）与 KPI / reflexion 关系；链至 `kpi-reflexion-design.md` |

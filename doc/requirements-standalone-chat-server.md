# 独立类 Discord 聊天服务 — 需求规格说明

> **版本**：v0.1（需求草案）  
> **状态**：仅文档，待评审后进入设计与实现  
> **关联**：仓库内 Chat IR 与内外脑编排见 [`inner-outer-protocol.md`](./inner-outer-protocol.md)；M7「第一方简易 IM」方向与此文档高度一致。

---

## 1. 背景与动机

- **现状**：生产或开发环境依赖 Discord 作为外脑出站/入站渠道时，可能因网络、区域策略或 Token 等问题无法稳定连接。
- **目标**：在 **不依赖 Discord** 的前提下，提供一套 **自建、可本地或内网部署** 的即时通讯能力，形态上接近 Discord 的核心体验（在线状态、会话、富媒体、@、引用），但 **刻意简化** 为多租户/多服务器模型之前的最小可用集。
- **集成**：Kuroneko（utlraKuroneko）侧需要 **与 `DiscordChannel` 同级的 Chat IR 适配器**，使 `OuterBrain`、持久化线程与现有 `postMessage` / `onAgentMessage` 流程保持一致。

---

## 2. 总体目标

| 维度 | 说明 |
|------|------|
| **聊天服务端** | 独立进程/服务，可配置监听地址与鉴权；支持实时推送（推荐 WebSocket，备选 SSE + 轮询降级）。 |
| **H5 客户端** | 浏览器可访问的单页或轻量多页应用，覆盖本文档列出的会话与展示能力。 |
| **Kuroneko 适配器** | 实现 `@utlra/chat-ir` 中的 **`ChatIRChannel`**（或与现有 `DiscordChannel` 相同的出站/入站契约），将服务端事件映射为 `ChatIRInboundMessage`，将 `postMessage` 映射为服务端 API。 |

### 2.1 非目标（本期明确不做或降级）

- **多服务器 / 多「公会」**：不要求类似 Discord 的 Server/Guild 层级；**全局仅一个「大群」**（见 §4.3）。
- **复杂权限 RBAC**：可先采用「注册用户 + 可选管理员」两级；频道级 ACL 可后续扩展。
- **语音/视频实时通话**：不要求 WebRTC 连麦（仅文字 + 附件 + 可选表情即可）。
- **端到端加密**：第一期以 **传输层 TLS + 服务端存储** 为主；E2EE 可作为远期专项。
- **消息无限漫游与联邦**：单部署实例内一致即可，不要求 Matrix 式联邦。

---

## 3. 术语

| 术语 | 含义 |
|------|------|
| **用户（User）** | 已注册或可匿名（若产品允许）的终端身份，具有稳定 `user_id` 与展示名。 |
| **会话 / 线程（Thread）** | 与 Kuroneko `thread_id` 对齐的逻辑单元：**私聊**为两人线程；**大群**为所有成员共享的单一 `thread_id`。 |
| **在线（Presence）** | 用户与服务器保持有效连接（如 WebSocket 存活）且在最近 N 秒内活跃，视为在线；具体策略可配置。 |
| **消息（Message）** | 带 `message_id`、发送者、时间、正文片段（`parts`）、可选引用与附件元数据。 |
| **Chat IR** | 仓库内 `MessageRecord` / `MessagePart`（text、mention、attachment 等）及 `ChatIRChannel` 抽象，适配器负责 **外部格式 ↔ IR** 的双向转换。 |

---

## 4. 聊天服务端 — 功能需求

### 4.1 鉴权与连接

- **注册 / 登录**（至少一种）：用户名+密码 或 **仅开发用 Token**；登录成功后签发 **会话 Token**（JWT 或随机 Session ID + HttpOnly Cookie）。
- **实时通道**：建立连接时携带 Token；断线重连后应能恢复订阅（至少恢复大群与已打开私聊的增量消息）。
- **可选**：同一用户多端登录策略（互踢 / 并存）在文档中二选一写死，避免实现分歧。

### 4.2 在线列表（Presence）

- **服务端维护**：当前在线用户集合（或带「离开/忙碌」等简化状态）。
- **推送**：用户上/下线、状态变更时，向 **订阅了在线列表的客户端** 广播或增量更新（大群成员默认订阅；私聊双方订阅彼此状态即可）。
- **与 Kuroneko 关系**：适配器可将「在线列表」用于外脑提示（可选）；**不强求** 写入 `threads.json`，但若外脑需要「当前有哪些人类在线」，需定义只读 API 或事件供适配器拉取。

### 4.3 群聊 — 单全局大群

- **模型**：整个部署实例内 **仅一个群聊线程**（例如固定 `thread_id = "global"` 或由服务端预置常量 UUID）。
- **成员**：所有已登录用户默认加入该群；**新用户注册/首次登录** 自动出现在该群成员列表中。
- **消息顺序**：单群内 **全序**（服务端分配单调序号或 UUID + 时间戳）；客户端按序展示，乱序到达时重排。
- **历史**：支持分页拉取历史消息（cursor / `before_message_id`），用于 H5 打开时补全上下文。

### 4.4 私聊（DM）

- **模型**：任意两用户 A、B 之间 **唯一** 私聊线程（`dm:{min_id}:{max_id}` 或服务端生成的稳定 `thread_id`）。
- **创建**：一方发起「打开与 B 的私聊」时，若线程不存在则服务端创建空壳线程；双方均可发消息。
- **可见性**：仅 A、B 可订阅该线程事件与历史；**不得** 出现在第三方的会话列表中。
- **与 Kuroneko**：每个 DM 对应 Chat IR 中一条独立 `thread_id`，与现有 `OuterBrain` 按线程隔离上下文的假设一致。

### 4.5 发文件与图片

- **上传**：客户端通过 **HTTPS `multipart/form-data` 或预签名直传** 上传二进制；服务端存储并生成 **`asset_id` 或稳定 URL**（对内可映射为 `ChatAssetStore` 的 `asset:` UUID，由适配器在 Kuroneko 进程内二次落盘或引用外链，需在实现阶段二选一）。
- **消息体**：消息中携带 **附件元数据**（文件名、MIME、大小、缩略图 URL 可选），与 Chat IR `MessagePart.type === 'attachment'` 对齐。
- **限制**：单文件大小上限、总附件数上限、禁止可执行后缀等（可配置）。
- **图片**：`image/*` 在 H5 内联预览；非图片以链接或图标下载形式展示。

### 4.6 @ 提及（Mentions）

- **语法**：与现有 Kuroneko / Discord 桥一致的方向——人类在输入框选择用户或输入约定 token（如 `@displayName` 或 `@user_id`），服务端 **持久化时存结构化 mention**（推荐存 `user_id` + 展示名快照），避免仅靠纯文本解析。
- **推送**：被 @ 的用户若在线，应收到 **高亮通知**（客户端本地通知 + 会话未读数）；若离线，可选邮件/Webhook（本期可不做）。
- **与 Chat IR**：出站/入站时适配器将外部 mention 转为 `MessagePart.mention`（含 `sid` 与 Kuroneko `IdentityRegistry` 可解析的标识）；**agent 的 `sender_sid` 与人类的 sid 映射** 必须在适配层显式配置（见 §6）。

### 4.7 引用回复（Reply / Quote）

- **用户操作**：回复某条消息时，客户端携带 **`reply_to_message_id`**（及可选被引用片段摘要，防删改歧义）。
- **展示**：H5 内显示「引用条」缩略 UI（发送者、原文前 N 字、可点击跳转原消息）。
- **与 Chat IR**：若当前 `MessageRecord` / `message.v1` 尚无正式 `reply_to` 字段，则 **二选一**：(a) 扩展 schema；(b) 在 `parts` 首条嵌入约定结构的 `text` 元数据（不推荐长期）。**建议** 在协议层增加可选 `reply_to?: { message_id, sender_sid, excerpt }`。

---

## 5. H5 聊天客户端 — 需求

### 5.1 基础能力

- **登录页**：输入凭据，成功后进入主界面。
- **布局**：左侧（或底部 Tab）为 **会话列表**：固定入口「大群」+ 动态私聊列表；右侧为当前会话消息时间线 + 输入区。
- **在线列表**：在主界面可见区域展示当前在线用户（可折叠侧边栏）；与大群成员列表可合并或分开展示（产品二选一）。
- **输入区**：支持多行文本、选择附件、选择 @ 对象、对某条消息点「回复」以带上 `reply_to_message_id`。

### 5.2 实时与弱网

- **首屏**：REST 拉取最近 K 条 + WebSocket 订阅增量。
- **断线**：自动重连、重连后补拉 `since_cursor` 避免漏消息。
- **发送失败**：消息状态「发送中 / 失败 / 已送达」；失败可重试。

### 5.3 兼容与部署

- **目标浏览器**：现代 Chromium / Safari / Firefox 近两主版本；**不要求** IE。
- **静态资源**：可部署在聊天同源或 CDN；**配置项**：聊天服务端 `API_BASE`、`WS_BASE`（便于 Kuroneko 反代同域）。

### 5.4 无障碍与国际化（可选）

- 第一期中文 UI 即可；文案抽离便于后续 i18n。

---

## 6. Kuroneko — Chat 服务器适配器需求

### 6.1 契约对齐

- **接口**：新建例如 `WebChatChannel`（名称待定），实现与 `DiscordChannel` 相同的 **`ChatIRChannel`** 能力：
  - `postMessage(threadId, body: ChatIROutboundBody)`：将 IR 出站转为聊天服务端 HTTP/WebSocket 发送。
  - 入站：订阅服务端事件，组装 `ChatIRInboundMessage`，调用注入的 **`onAgentMessage`**（与 Discord 桥一致，见 `inner-outer-protocol.md` §2.1）。
- **线程映射**：
  - 大群：`thread_id` 固定映射到服务端全局群 ID。
  - 私聊：Discord 的 `threadId` 与自建服的 `thread_id` 使用 **同一套 Chat IR 持久化键**（即 Kuroneko 只认 `thread_id`，适配器负责与外部 ID 双向映射表，可存内存 + 可选落盘）。
- **身份**：`IdentityRegistry` 中注册人类用户与 agent；**@agent** 的解析规则与现有 `plainTextToPartsWithMentions` / 外脑策略对齐，避免双轨行为。

### 6.2 配置项（环境变量或配置文件草案）

| 变量 / 键 | 说明 |
|-----------|------|
| `WEBCHAT_API_BASE` | 聊天服务端 REST 根 URL |
| `WEBCHAT_WS_URL` | WebSocket URL |
| `WEBCHAT_BOT_TOKEN` 或 `WEBCHAT_SERVICE_ACCOUNT` | 适配器代表 agent 发消息用的凭证 |
| `WEBCHAT_GLOBAL_THREAD_ID` | 与服务器大群 ID 一致 |
| `UTLRA_AGENT_SID` / 已有 agent sid | 出站 `sender_sid` |

### 6.3 与 `packages/server` 启动流程

- 与 Discord 分支类似：`DISCORD_BOT_TOKEN` 缺失时可选用 **WebChat** 作为 `ChatIRChannel` 实现；日志中明确当前渠道。
- **不要求** WebChat 与 Discord 同时启用（若同时启用，需定义 thread 路由规则，本期建议 **互斥**）。

---

## 7. 服务端 API / 事件 — 实现无关草案

> 具体路径与方法可在设计评审后定稿；此处仅列 **能力面**。

**REST（示例能力）**

- `POST /auth/login`、`POST /auth/register`（可选）
- `GET /me`、`GET /users/online`
- `GET /threads`、`GET /threads/:id/messages?cursor=`
- `POST /threads/:id/messages`（JSON：text、parts、reply_to、attachment_ids）
- `POST /uploads`（multipart）

**WebSocket（示例事件类型）**

- `presence.sync` / `presence.update`
- `message.new` / `message.ack`
- `typing.*`（可选）
- `error`（统一错误载荷）

---

## 8. 安全与非功能需求

- **TLS**：公网部署必须 HTTPS / WSS。
- **鉴权**：所有 mutating 与订阅类接口必须校验 Token；**禁止** 匿名写大群（除非显式开启「演示模式」且默认关闭）。
- **速率限制**：登录、发消息、上传文件分别限流，防刷与防 DOS。
- **审计**：可选记录管理员操作与消息删除（若实现撤回/删除）。

---

## 9. 验收标准（建议）

1. 两名用户通过 H5 登录后，**同时出现在在线列表**；一方下线后另一方在 T 秒内看到状态更新。  
2. 二人在 **大群** 互发文字、图片、小文件，对方均正确显示；刷新页面后历史仍在。  
3. 二人建立 **私聊**，第三人在任何 API 下 **不可读** 该私聊消息。  
4. **@对方** 后，被 @ 方客户端出现可感知提示（角标或高亮）；服务端存储结构含被 @ 用户 id。  
5. **引用回复** 后，消息链上可见引用关系，且 `message_id` 可追溯。  
6. 启动 Kuroneko 配置 WebChat 适配器后，**agent 在大群回复** 与 **人类触发外脑 roundtrip** 行为与当前 Discord 模式等价（以 `inner-outer-protocol` 流程为准做对比测试）。

---

## 10. 文档后续动作

- [ ] 与 `greenfield-milestones.md` / M7 条目合并或交叉引用，避免重复造轮子。  
- [ ] 产出 **OpenAPI + WebSocket 事件** 正式版。  
- [ ] 定义 `message.v1` 是否扩展 `reply_to` 字段（需 `@utlra/chat-ir` 变更评审）。  
- [ ] H5 线框图与适配器类图（可选）。

---

## 11. 修订记录

| 日期 | 作者 | 说明 |
|------|------|------|
| 2026-05-13 | （助理起草） | 初稿：背景、功能拆分、H5、适配器、验收 |

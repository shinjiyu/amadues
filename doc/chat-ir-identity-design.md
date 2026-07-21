# 聊天层 IR 与身份子系统设计

**版本**：v2.1（跨渠道认同改以 Structurizr ADL 为准）
**最近更新**：2026-07-16
**实施状态**：设计 ≈ 95% 已落地；跨渠道同人运行时见 [`structurizr/IDENTITY-CROSS-CHANNEL.md`](./structurizr/IDENTITY-CROSS-CHANNEL.md)（⏳ 实现）。

> 本文档既是设计稿，也是与现状的对照表。每节末尾的「实现状态」给出代码引用与已知差距。

---

## 0. TL;DR（懒人速览）

- **chat IR** = 渠道无关的统一消息表示（`MessageRecord` / `ThreadRecord` / `MessagePart`）。
- **身份是一等公民**：消息只引用稳定身份 `sid`，画像与渠道映射在 `IdentityRegistry` 维护。
- **多说话者**：每条消息显式带 `sender_sid`，废弃 user/assistant 二元假设。
- **出站结构化**：LLM 输出受 `reply.v1` schema 约束，渲染器再转渠道 wire，避免格式漂移。
- **agent 与 IM 解耦**：agent 业务代码面对 `ChatIRChannel` interface（3 方法 + 1 callback），不依赖任何具体渠道。当前唯一外部实现是 `DiscordChannel`（直接对接 Discord Gateway / REST），未配 Discord 时有内置 `NullChatIRChannel` 兜底。详见 §10.1。
- **跨 IM 身份统一**：认知层 = `channel_key → internal_sid`；同人事实源 = **双边确认**（[`IDENTITY-CROSS-CHANNEL.md`](./structurizr/IDENTITY-CROSS-CHANNEL.md)）。当前代码仍 per-channel；见 §11。

---

## 1. 设计目标与非目标

### 1.1 目标

1. **入站**：任意渠道（Discord、Web、未来的飞书/钉钉/Slack）→ 统一 **Canonical Message IR**。
2. **出站**：LLM 输出 **结构化语义意图**（含身份引用），由 **渲染器** 生成渠道 wire，避免多轮格式漂移。
3. **身份**：全局 **稳定身份标识** + 与渠道 raw id **显式绑定**；LLM 每轮具备 **基身份知识包**（谁是谁、我是谁、如何引用）。
4. **可演进**：IR 与身份 schema **带版本**；新 Part 类型可增。

### 1.2 非目标

- 不规定具体 LLM 型号或工具调用框架。
- 不规定中央身份是否用 OIDC（可对接，但非本文必需）。
- 不与外部"中继层"产品（如 CAR）兼容；我们 identity-first 模型与 message-centric 中继不同构（见 §11）。

### 1.3 实现状态

✅ 入站：Discord 渠道桥直接进 agent 进程运行（`packages/discord-bridge/DiscordChannel`），落 chat IR 与触发 agent callback 全部进程内完成，无中间 IM Server。
✅ 出站：`reply.v1` 已实现并被外脑使用，详见 §5。
✅ 身份子系统：`IdentityRegistry` 完整可用，含跨渠道 `bindings` 字段；详见 §2。
✅ 版本演进：`schema: "message.v1" / "identity.v1" / "reply.v1"` 三个 schema 各带版本号。
✅ 抽象边界：`ChatIRChannel` interface 已落地（`packages/core/src/chat-ir-channel.ts`），`outer/*` 业务代码全部基于接口编程；详见 §10.1。
⛔ 多实现：当前外部 `ChatIRChannel` 实现仅有 `DiscordChannel`；in-memory / 飞书 / Slack 等渠道实现待补。

---

## 2. 身份子系统（Identity Subsystem）

身份与消息 **解耦**：消息只引用 `sid`；画像与渠道映射在 **IdentityRegistry** 维护。

### 2.1 核心概念

| 概念 | 说明 |
|------|------|
| **Identity（身份）** | 系统中可被指代、被 @、可发言或可被代理的实体。 |
| **Stable Identity Id（SID）** | 全局唯一字符串。**当前编码**：见 §13；**理想编码**：渠道无关 ULID（`idp:01J8X...`），已规划未实施。 |
| **Persona（人设面）** | 同一自然人在不同上下文下的展示，仍可映射到同一 SID。当前未单独建模。 |
| **Channel Binding（渠道绑定）** | `(channel, native_user_id)` → SID 的映射；保存在 `IdentityRecord.bindings`。 |
| **基身份知识（Identity Context Pack）** | 注入 LLM 的 **压缩、确定性** 文本块：固定包含 **自我、参与者、解析规则**。 |

### 2.2 身份种类 `IdentityKind`

```text
human          # 人类用户
agent          # 自动化助手（本系统扮演的 bot 或同群其他 bot）
service        # 仅系统内部、无 UI（如 cron、webhook）
group          # 群组作为逻辑主体（用于「群设置」类操作；当前未真正使用）
```

**实现**：

```5:6:packages/core/src/identity.ts
export const IdentityKindSchema = z.enum(['human', 'agent', 'service', 'group']);
export type IdentityKind = z.infer<typeof IdentityKindSchema>;
```

### 2.3 身份记录 `IdentityRecord`

```json
{
  "schema": "identity.v1",
  "sid": "discord:user:1234567890",
  "kind": "human",
  "display_name": "张三",
  "aliases": ["小张"],
  "roles_in_tenant": ["member"],
  "bindings": [
    { "channel": "discord", "native_user_id": "1234567890", "native_union_id": "guild_xyz" }
  ],
  "updated_at": "2026-05-11T12:00:00Z"
}
```

**Agent 自身** 同样是一条 `IdentityRecord`，`kind: "agent"`，含 `bindings` 指向各渠道 bot id。

**实现**：

```14:24:packages/core/src/identity.ts
export const IdentityRecordSchema = z.object({
  schema: z.literal('identity.v1'),
  sid: z.string(),
  kind: IdentityKindSchema,
  display_name: z.string(),
  aliases: z.array(z.string()).default([]),
  roles_in_tenant: z.array(z.string()).optional().default([]),
  bindings: z.array(ChannelBindingSchema).default([]),
  updated_at: z.string(),
});
```

⚠️ **与原设计稿的差异**：
- `metadata` 字段（如 `department`）：原稿示例里有，当前 schema 未实现，可后续按需扩。
- `locale` 字段：原稿示例里有，当前 schema 未实现。

### 2.4 身份注册表 `IdentityRegistry`

**职责**：

| 方法 | 含义 |
|------|------|
| `get(sid)` | 按 SID 取记录 |
| `upsert(rec)` | 写入 / 更新（自动刷 `updated_at`，落盘到 `identities.json`）|
| `list()` | 全量列表 |
| `resolveMentionToken(token)` | 把展示名 / 别名 / 完整 SID 解析为身份；歧义返回多候选 |
| `packForThread(threadId, tenantId, kind, participants)` | 按线程参与者构造 `IdentityContextPack`（自动包含主助手）|
| `save()` | 落盘到 JSON |

**实现**：完整在 `packages/core/src/identity.ts:129-311`，约 180 行；持久化为单个 `identities.json` 文件，由 agent 主进程拥有读写（渠道桥通过注入的 `IdentityRegistry` 实例共享）。

### 2.5 主助手 SID 配置

主助手 SID 通过环境变量 `UTLRA_PRIMARY_AGENT_SID` 配置，未设置时默认 `idp:agent:assistant`。

```43:54:packages/core/src/identity.ts
export function resolvePrimaryAgentSid(): string {
  try {
    const v =
      typeof process !== 'undefined' && process.env
        ? process.env['UTLRA_PRIMARY_AGENT_SID']?.trim()
        : undefined;
    if (v) return v;
  } catch {
    /* ignore */
  }
  return DEFAULT_PRIMARY_AGENT_SID;
}
```

**Registry 在初始化时会自动 seed 主助手记录**（除非启用 demo 开放模式），并自动迁移历史 SID（旧值 `idp:agent:self` → 当前主 SID）。

### 2.6 Demo 开放模式 `UTLRA_IM_OPEN_DEMO`

设置 `UTLRA_IM_OPEN_DEMO=1` 时：
- 不预 seed 任何身份；
- 任意 `sender_sid` 首次出现时由 `ensureOpenDemoIdentity` 自动登记一条 `kind: human` 记录；
- 用于 Web IM 的零配置体验。

注意：本开关原为 IM Server 时代的默认调试模式，IM Server 删除后含义降级为"是否在 agent 启动时种子默认主助手身份"。

### 2.7 基身份知识包 `IdentityContextPack`（给 LLM）

每轮注入，**与具体消息内容分离**，避免被长对话冲掉。

**结构**：

```85:89:packages/core/src/identity.ts
export interface IdentityContextPack {
  self: IdentityRecord;
  participants: IdentityRecord[];
  threadSummary: { thread_id: string; tenant_id: string; kind: 'dm' | 'group' };
}
```

**序列化为 LLM 文本块**（实际生成五块）：

```text
[SELF]
sid=idp:agent:assistant name=Assistant kind=agent

[PARTICIPANTS]
sid=discord:user:1234 name=张三 kind=human aliases=小张

[ROLES]
idp:agent:assistant: assistant,bot
discord:user:1234: member

[THREAD]
thread_id=tnt:default:discord:group:xxx tenant=default kind=group

[PRONOUNS]
「你」= 本栈主助手（上列 [SELF]，sid=idp:agent:assistant）；
「我」= 该条消息头 from:sid 中的说话者（每条消息不同，多 agent 时勿与 [SELF] 混淆）。
```

⚠️ **与原设计稿的差异**：
- 原稿规划 `[MENTION_MAP]` 块，**已实现**但由 agent 业务代码在序列化时动态附加（不是 Registry 内置）。
- 原稿规划 `[POLICY]` 块（红线话术），**未实现**。

### 2.8 多说话者模型（超越 user / assistant 二元）

传统 chatbot 用 **仅 `user` 与 `assistant` 交替** 的 transcript，在 **群聊 / 多用户 / 多机器人** 场景下会系统性失败。

**本协议要求**：

1. **每条消息显式带说话人**：`MessageRecord.sender_sid` **必填**；助手发出的消息若落库，同样是一条 `MessageRecord`，`sender_sid = SELF.sid`。

2. **多种身份并存**：
   - 多个 **human**：不同 `sid`；历史里必须能区分。
   - **本助手（SELF）** 与 **其他 agent**（同群其他 bot）：均为 `kind: "agent"`，**以不同 `sid` 区分**。

3. **给 LLM 的历史格式**：每条消息序列化为 `[from:sid:xxx|name(kind:xxx)|时间] 正文`。

   **实现**：

```86:101:packages/core/src/chat-ir.ts
export function serializeMessageForLlm(msg: MessageRecord, senderDisplayName: string, senderKind: string): string {
  const timeTag = msg.sent_at ? formatMessageTime(msg.sent_at) : '';
  const timePart = timeTag ? `|${timeTag}` : '';
  const header = `[from:sid:${msg.sender_sid}|${senderDisplayName}(kind:${senderKind})${timePart}]`;
  const body = msg.parts
    .map((p) => {
      if (p.type === 'text') return p.text;
      if (p.type === 'mention') return `[@sid:${p.target_sid}|${p.label ?? ''}]`;
      if (p.type === 'quote')
        return `[quote:${p.quoted_message_id}]"${p.excerpt ?? ''}"`;
      if (p.type === 'attachment') return `[file:${p.asset_ref.kind} ${p.asset_ref.uri}]`;
      return `[unknown]`;
    })
    .join('');
  return `${header}\n${body}`;
}
```

4. **指代消解规则**（写入 Pack `[PRONOUNS]` 块）：
   - 「我」= 当前消息头 `from:sid` 的说话者；
   - 「你」= `[SELF]`；
   - 仅说「他/她」无 SID：模型应要求澄清。

5. **同名 / 相似展示名**：`[PARTICIPANTS]` 中若 `display_name` 冲突，提示模型以 SID 为准。

---

## 3. 消息 IR（Canonical Message）

### 3.1 线程 `ThreadRecord`

```json
{
  "schema": "thread.v1",
  "thread_id": "tnt:default:discord:group:xxx",
  "tenant_id": "default",
  "channel": "discord",
  "kind": "group",
  "title": "Discord Guild: 测试服",
  "participant_sids": ["idp:agent:assistant", "discord:user:1234"],
  "created_at": "2026-05-10T08:00:00Z"
}
```

**实现**：

```41:50:packages/core/src/chat-ir.ts
export const ThreadRecordSchema = z.object({
  schema: z.literal('thread.v1'),
  thread_id: z.string(),
  tenant_id: z.string(),
  channel: z.string(),
  kind: z.enum(['dm', 'group']),
  title: z.string().optional(),
  participant_sids: z.array(z.string()),
  created_at: z.string(),
});
```

⚠️ **当前限制**：`kind` 仅 `dm | group` 二元；理想三元（`dm | group | channel`）以区分"小群"vs"千人频道"未实施。

### 3.2 消息 `MessageRecord`

```json
{
  "schema": "message.v1",
  "message_id": "discord:1234567890",
  "thread_id": "tnt:default:discord:group:xxx",
  "sender_sid": "discord:user:1234",
  "sent_at": "2026-05-11T12:00:00Z",
  "reply_to_message_id": "discord:9876543210",
  "parts": [...]
}
```

**实现**：

```29:39:packages/core/src/chat-ir.ts
export const MessageRecordSchema = z.object({
  schema: z.literal('message.v1'),
  message_id: z.string(),
  thread_id: z.string(),
  sender_sid: z.string(),
  sent_at: z.string(),
  reply_to_message_id: z.string().optional(),
  parts: z.array(MessagePartSchema),
});
```

⚠️ **未实施字段**（doc 设计有，schema 没补）：
- `ingested_at`：渠道桥落库时间，与 `sent_at` 区分（用于乱序消息排障）。
- `provisional`：标记未验证身份发出的消息。

### 3.3 片段 `MessagePart`（有序、可扩展）

所有富语义 **必须** 体现在 `parts`，**禁止**把未解析的渠道私有标签当唯一真相源。

| `type` | 必填字段 | 说明 |
|--------|----------|------|
| `text` | `text: string` | UTF-8 纯文本段。 |
| `mention` | `target_sid`, `label?: string` | `label` 仅为当时展示快照；**逻辑引用以 SID 为准**。 |
| `quote` | `quoted_message_id`, `excerpt?: string` | 摘要可选；无则客户端仅显示「引用了一条消息」。 |
| `attachment` | `asset_ref` | 见 §3.4。 |
| `unknown` | `channel`, `opaque` | 适配器无法解析时落此，供排障；**不**默认喂给 LLM 原文 unless 策略允许。 |

**实现**：

```3:25:packages/core/src/chat-ir.ts
export const MessagePartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('mention'),
    target_sid: z.string(),
    label: z.string().optional(),
  }),
  z.object({
    type: z.literal('quote'),
    quoted_message_id: z.string(),
    excerpt: z.string().optional(),
  }),
  z.object({
    type: z.literal('attachment'),
    asset_ref: z.object({
      kind: z.enum(['image', 'video', 'audio', 'file']),
      uri: z.string(),
      mime: z.string().optional(),
      name: z.string().optional(),
    }),
  }),
  z.object({ type: z.literal('unknown'), channel: z.string(), opaque: z.unknown() }),
]);
```

⚠️ **未实施类型**（doc 提及）：
- `location`：`{ lat, lng, name? }`。

**示例 parts**（Discord 桥实测产出）：

```json
[
  { "type": "mention", "target_sid": "idp:agent:assistant", "label": "助手" },
  { "type": "quote", "quoted_message_id": "discord:9876", "excerpt": null },
  { "type": "text", "text": "@助手 看下这个" },
  { "type": "attachment", "asset_ref": {
      "kind": "image",
      "uri": "/api/im/assets/xyz123",
      "mime": "image/png",
      "name": "截图.png"
  }}
]
```

### 3.4 附件引用 `AssetRef`

**当前实现**：

```typescript
{
  kind: "image" | "video" | "audio" | "file",
  uri: string,           // internal: /api/im/assets/{id} ；external: https://...
  mime?: string,
  name?: string,
}
```

⚠️ **未实施字段**（doc 设计有）：
- `size_bytes`：Discord/IM 都已知，丢弃可惜。
- `thumbnail_uri`：图片/视频缩略图。

**原则**：进入 IR 时尽量 **拉取到本地 `ChatAssetStore`**（`packages/core/src/chat-asset-store.ts`），URI 为 `asset:<uuid>` 形式（出站渲染时由渠道桥通过 `assetStore.get(id)` 取出 multipart 上传），避免把过期外链直接当长期历史。Discord 桥默认开启附件下载（`DISCORD_BRIDGE_DOWNLOAD_ATTACHMENTS=1`）。

---

### 3.5 时间字段约定（强制 ISO 8601 with offset）

Chat IR 中所有时间字段——`MessageRecord.sent_at` / `ThreadRecord.created_at` / `IdentityRecord.updated_at` / `ChatAsset.created_at`——**统一约定为 ISO 8601 带时区偏移的字符串**。

**强制规则**：

| 项 | 规定 |
| --- | --- |
| 格式 | `YYYY-MM-DDTHH:mm:ss.sssZ` 或 `YYYY-MM-DDTHH:mm:ss.sss±HH:mm` |
| 时区 | **必须带 offset**（推荐用 UTC `Z`） |
| 推荐写法 | `new Date().toISOString()` |
| 不允许 | `"2024-01-01 12:00:00"`（无 offset，本地时间字符串） |
| 不允许 | epoch 数字 / Date 对象（破坏 JSON 可序列化） |
| schema 校验 | `z.string().datetime({ offset: true })`（已在 `packages/chat-ir/src/schemas/*.ts` 强制） |

**为什么强制 offset**：

1. **可比较 / 可排序**：字符串字典序与时间序一致，可以直接 `messages.sort((a, b) => a.sent_at.localeCompare(b.sent_at))`。
2. **跨时区可还原**：从 UTC 时间还原本地时间是确定的；从无 offset 的"本地时间字符串"还原则需要外部上下文，容易产生差 8 小时类的 bug。
3. **schema fail-fast**：`z.string().datetime({ offset: true })` 在 parse 阶段就拒绝异常格式，避免某条消息悄悄写进 `threads.json` 后续 `sort` 排错或 `new Date(...)` 得到 `Invalid Date` 。

**写入端职责**（任何产生 `MessageRecord` / `ThreadRecord` / `IdentityRecord` 的代码）：

```typescript
// 当前时刻：
sent_at: new Date().toISOString(),

// 来自渠道平台的 epoch 时间戳（Discord 的 createdTimestamp）：
sent_at: new Date(msg.createdTimestamp).toISOString(),

// ❌ 错误：
sent_at: '2024-01-01 12:00:00',           // 缺 offset
sent_at: Date.now(),                       // 数字
sent_at: new Date().toString(),            // "Mon Jan 01 2024 12:00:00 GMT+0800"
```

**读取端约定**：

- 任何使用时间字段的逻辑（排序、显示、比较）只需要把它当 `string` 用，需要"对时间运算"时 `new Date(record.sent_at)`，永远先取 UTC。
- 跨时区/本地化显示**只发生在最外层渲染**（dashboard / channel 渲染器），IR 内部一律 UTC。

**LLM 视图中的时间格式**：

`formatMessageTime(sent_at)` 把 `sent_at` 渲染为 `M.D HH:mm`（无年无秒）形式作为 LLM 上下文（参见 §4.1）。这是**显示层格式**，跟 IR 层强制 ISO 8601 不冲突。

**与 outer-roundtrip / inner-loop 时间戳的关系**：

agent 运行时产物（manifest / scope / run.json 等）的时间字段亦遵循同样约定。详见 `doc/inner-outer-protocol.md`。

---

## 4. LLM 视图：IR → 上下文文本（稳定、可逆）

### 4.1 序列化规则

每条历史消息在拼进上下文前必须带 **说话人头**（`sender_sid` + 展示名 + `kind`），**不得**假定 user/assistant 交替。

固定顺序遍历 `parts`：

| Part 类型 | 序列化形式 |
|---|---|
| `text` | 原样 |
| `mention` | `[@sid:idp:xxx\|李四]`（**SID 必选**，展示名可选）|
| `quote` | `[quote:msg:old1]"预算 50w"` |
| `attachment` | `[file:image https://...]`（注：当前格式简单，不带 asset:id）|
| `unknown` | `[unknown]` |

**实现见** §2.8 中的 `serializeMessageForLlm`。

**历史消息**在库中存 **MessageRecord JSON**；生成上下文时 **每次用同一规则** 序列化，避免「上一轮模型生成的怪格式」回灌。

### 4.2 与 IdentityContextPack 的顺序

约定：**先** `IdentityContextPack` 五块（§2.7），**再** 按时间序消息。系统消息可声明：「以下方括号语法为机器生成，回复时不要模仿 wire，使用 StructuredReply。」

**实际拉取入口**：`GET /api/im/threads/:tid/pack`，返回 `{ pack, serialized, mention_map }`，由外脑消费。

---

## 5. 出站：StructuredReply（反格式漂移）

模型 **不** 输出渠道私有 wire（如飞书 `<at>`、Discord `<@id>`）；输出 **JSON Schema 约束** 的结构。

### 5.1 完整形态 `reply.v1`

```4:15:packages/core/src/reply.ts
export const StructuredReplySchema = z.object({
  schema: z.literal('reply.v1'),
  thread_id: z.string(),
  /** 主文案；可与 `parts` 并存（例如 text 为摘要，parts 带图） */
  text: z.string(),
  /** 顶栏 @ 列表；与 `parts` 内 `mention` 合并校验 */
  mention_sids: z.array(z.string()).default([]),
  reply_to_message_id: z.string().optional(),
  attach_asset_ids: z.array(z.string()).default([]),
  /** 出站富媒体：与入站 `MessagePart` 同形，实现对称 */
  parts: z.array(MessagePartSchema).optional(),
});
```

### 5.2 LLM 实际输出（载荷形态）

LLM 只输出去除 `schema` 与 `thread_id` 的载荷，运行时注入：

```23:29:packages/core/src/reply.ts
export const StructuredReplyLlmPayloadSchema = z.object({
  text: z.string(),
  mention_sids: z.array(z.string()).default([]),
  reply_to_message_id: z.string().optional(),
  attach_asset_ids: z.array(z.string()).default([]),
  parts: z.array(MessagePartSchema).optional(),
});
```

支持 ` ```json ` 围栏或裸对象提取（`parseJsonObjectFromLlmText`）。

### 5.2.1 `attach_asset_ids`：运行时展开为 attachment parts

`reply.v1` 的 `attach_asset_ids: string[]` 是 LLM 引用本地 / 已知 asset 的**简洁形式**——只需给裸 UUID，无需手写完整 `MessagePart.attachment` 对象。

**运行时语义**（由外脑出站层强制执行）：

1. **拼接**：对每个 `id`，按 chat IR `asset:<uuid>` URI 约定 + `ChatAssetStore.get(id)` 拿到 `AssetMeta`，**自动**追加 attachment part 到 `parts` 末尾。
2. **校验**：每个 `id` **必须**在以下"允许集合"中可解：
   - 当前 `inner-status.v1.deliverables[].asset_id`（内脑产物，详见 `doc/protocols/inner-brain-deliverables.md`）；
   - 当前 thread **入站**消息曾经携带的 asset_id；
   - 当次任务上下文 pack 注入的 asset_id。
3. **降级**：不通过校验的 id **静默剔除该条 attach**（记 warning），**不阻断**整条回复——避免 LLM 一个手抖把回复整条拒掉。
4. **前缀容忍**：LLM 若误写 `asset:xxx`，运行时**自动 strip** `asset:` 前缀后再校验。`attach_asset_ids` 协议层定义为**裸 UUID**。
5. **与 `parts[].attachment` 共存**：两者**不去重**；LLM 想"再发一次"或"先 parts 后 attach 补遗"都合法。

> 出站附件的**唯一合法形态**仍是 `MessagePart.attachment`（§3）；`attach_asset_ids` 是它的"语法糖"，运行时一定会被展开为 part。

### 5.3 校验：mention SID 必须来自允许集合

```75:85:packages/core/src/reply.ts
export function validateReplyMentions(
  reply: StructuredReply,
  allowedSids: Set<string>,
): { ok: true } | { ok: false; error: string } {
  for (const sid of collectMentionSidsFromReply(reply)) {
    if (!allowedSids.has(sid)) {
      return { ok: false, error: `unknown mention sid: ${sid}` };
    }
  }
  return { ok: true };
}
```

`allowedSids` = 当前 `IdentityContextPack` 中所有参与者 + 本助手；**LLM 不得发明 SID**。

### 5.4 渠道渲染器（Channel Renderer）

`reply.v1` → 渠道 wire 的转换由各渠道桥实现：

| 渠道 | 渲染位置 | 主要工作 |
|---|---|---|
| Discord | `packages/discord-bridge/src/reply-render.ts` | mention SID → `<@native_id>`、`reply_to_message_id` → Discord reply 引用 |
| Web IM | （直接吃 `reply.v1`，IM Web 前端自己渲染）| 不需要 wire 转换 |
| Mock | `renderMockChannel` in `packages/core/src/reply.ts:109-121` | 调试用，输出可读文本 |

---

## 6. 身份与 IR 的交叉规则

1. **任何 `mention` 必须带 `target_sid`**；适配器入站时若只能拿到原生 id（如 Discord user id），须 **经 Registry 解析或创建** 后再写入 IR。
2. **LLM 禁止发明 SID**；只允许使用 `IdentityContextPack` 与历史中出现的 SID。`validateReplyMentions` 在发送前拦截非法 SID。
3. **「@展示名」歧义**：StructuredReply 只接受 SID；若模型只有自然语言「@张三」，需 **二次解析**（`registry.resolveMentionToken`）或 **拒发** 要求澄清。
4. **群聊 vs DM**：`ThreadRecord.kind` 影响 **默认 mention 是否必需**、**可见性**。
5. **入站文本中的 @**：`plainTextToPartsWithMentions` 把纯文本 @ token 解析为 mention part（用于 Web IM 的纯文本输入）；解析失败保留原文不强转。

---

## 7. 存储与索引

### 7.1 当前实现：JSON 文件持久化

| 实体 | 存储 | 文件 |
|------|------|------|
| `IdentityRecord` | JSON 数组 | `<DATA_ROOT>/identities.json` |
| `ThreadRecord` + `MessageRecord` | 单文件 JSON 树 | `<DATA_ROOT>/chat/threads.json` |
| 附件二进制 | 文件系统 | `<DATA_ROOT>/chat/uploads/` |
| Discord 桥 channel↔thread 映射 | JSON | `<DATA_ROOT>/discord/maps.json` |

`DATA_ROOT` 由 `UTLRA_DATA_ROOT` 控制，默认 `packages/server/data`，agent 主进程统一持有；渠道桥通过注入的 `loadThreads` / `saveThreads` 共享同一份磁盘。

### 7.2 规划但未实施

| 实体 | 规划存储 | 索引 |
|------|------|------|
| `IdentityRecord` | KV / 表，key = `sid` | `bindings` 联合索引 |
| `MessageRecord` | 按 `thread_id` 分片，有序 | `message_id`, `sent_at` |
| `ThreadRecord` | 独立表 | `tenant_id`, `channel` |
| Asset 元数据 | 表 | `asset_id`, `mime` |

JSON 单文件方案在小数据量下足够（< 10 万条），万级以上需迁移到 SQLite 或外部 KV。

---

## 8. 版本与扩展

- `schema: "message.v1"` / `"thread.v1"` / `"identity.v1"` / `"reply.v1"` 字段 **只增不删**。
- 新 `MessagePart.type` 需在协议表登记；适配器未知则 `unknown` + 日志。
- 待加字段（按优先级）：`MessageRecord.ingested_at`、`AssetRef.size_bytes / thumbnail_uri`、`ThreadRecord.kind` 三元化、`MessagePart.location`、`provisional` 标记。

---

## 9. 与数据层草案的关系

- **交互轨**知识：以 **`thread_id` + `tenant_id`** 为边界；**IdentityRecord** 中的 PII 字段 **不** 进入执行轨晋升。
- **基身份知识** 属于 **聊天层运行时构造**，可 **不入库** 或仅审计采样；持久真相是 **IdentityRegistry + MessageRecord**。
- 与 `data-layer-phase1-draft.md` 的 `InteractionEntity` / `ParticipantProfile` 概念对齐：`MessageRecord` ≈ Message；`IdentityRecord` ≈ ParticipantProfile。

---

## 10. 运行时物理形态

### 10.1 抽象边界：`ChatIRChannel` interface + `ChatIRSeenTracker`

**agent 业务代码不直接看 IM 协议**。它面对两个抽象：

```typescript
// packages/chat-ir/src/channel.ts —— 只管传输
interface ChatIRChannel {
  start(): void;
  destroy(): void;
  postMessage(threadId: string, body: ChatIROutboundBody): Promise<void>;
}
// 加上构造时注册的 onAgentMessage(ev: ChatIRInboundEvent) callback

// packages/chat-ir/src/seen-tracker.ts —— 对消息序列的查询
class ChatIRSeenTracker {
  track(threadId, { message_id, sender_sid, mention_target_sids? }): void;
  countConsecutiveAgentMessages(threadId): number;
  /** 仅与触发消息上被一并 @ 的 agent 构成抢答；独占 @ 本 agent 时返回 false */
  hasAnotherAgentRepliedAfter(threadId, triggerMessageId): boolean;
}
```

**职责分离**：
- `ChatIRChannel`：传输——连接、发消息、入站 callback。具体实现（DiscordChannel / 未来 Lark / Slack）各自不同。
- `ChatIRSeenTracker`：聊天记录上的"运行时观察"查询。**与具体渠道无关**，所有 channel 实现共享同一个 tracker 实例。

**契约**：channel 实现必须在**入站消息落库后**与**出站消息发送成功后**各调一次 `seenTracker.track(...)`，并尽量带上 `mention_target_sids`（从 mention parts 提取）。tracker 才能给业务侧提供完整的反 loop / 新鲜度（含「分别 @ 不同 agent 不互掐」）信号。

| 实现 | 状态 | 位置 |
|---|---|---|
| `DiscordChannel`（Discord Gateway 入站 + REST 出站） | ✅ 当前唯一外部实现 | `packages/discord-bridge/src/discord-channel.ts` |
| `NullChatIRChannel`（postMessage 仅打日志） | ✅ 内置兜底 | `packages/server/src/index.ts`（未配 Discord 时使用，HTTP `POST /api/outer/inbound` 可用） |
| `InMemoryChatIRChannel`（进程内全量内存） | ⛔ 未实现，可选 | 用于 CLI / 单元测试 / 极简部署 |
| `LarkChatIRChannel` / `SlackChatIRChannel` | ⛔ 未实现 | 各家 IM 直连，参考 `DiscordChannel` 编写 |

**关键点**：所有 `outer/*` 业务代码 import `ChatIRChannel` 类型，**只有 `packages/server/src/index.ts` 入口知道并 `new DiscordChannel(...)` / `new NullChatIRChannel()`**。换实现不动业务代码。

### 10.2 当前进程拓扑（DiscordChannel 实现）

```text
              ┌──────────────────────────────────────────────────────┐
              │  packages/core (chat IR + identity 数据 schema)       │
              │  + ChatIRChannel interface                            │
              │  IdentityRegistry / ChatAssetStore / chat-ir-store    │
              │  MessageRecord / ThreadRecord / StructuredReply       │
              └──────────────────────────────────────────────────────┘
                                ▲          ▲
                schema/store 引用│          │ChatIRChannel 接口
                                │          │
   ┌─────────────────────────────────────────────────────┐
   │ Agent 进程 (packages/server, port 8787)              │
   │                                                      │
   │  ┌─────────────────────────┐    ┌────────────────┐ │
   │  │ outer/*（OuterBrain /    │    │ ChatIRSeenTracker│ │
   │  │ PushLoop / Heartbeat /   │◄──►│ 进程内单例，反 loop│ │
   │  │ Tools / 对话循环）        │    │ + 新鲜度查询      │ │
   │  └────────────┬────────────┘    └─────▲──────────┘ │
   │      imClient:│                       │ track()    │
   │  ChatIRChannel│ ChatIRInboundEvent     │           │
   │               ▼                       │           │
   │  ┌─────────────────────────────────────┴────────┐ │
   │  │ DiscordChannel（implements ChatIRChannel）    │ │
   │  │  - inbound: Discord Gateway → 落 store        │ │
   │  │    → seenTracker.track(...) → callback        │ │
   │  │  - outbound: postMessage → Discord REST       │ │
   │  │    → 落 store → seenTracker.track(...)        │ │
   │  └────────────┬──────────────────────────────┬─┘ │
   │               │ 共用 registry / threads.json │   │
   │               │ uploads/                     │   │
   │  ┌────────────▼──────────────────────────────▼─┐ │
   │  │ 数据根 UTLRA_DATA_ROOT/                          │ │
   │  │  identities.json   threads.json   chat/uploads/  │ │
   │  └──────────────────────────────────────────────────┘ │
   └───────────────────────┬──────────────────────────────┘
                           │ Discord Gateway / REST
                           ▼
                  ┌────────────────┐
                  │ Discord API    │
                  └────────────────┘
```

### 10.3 关键事实

- **chat IR + identity schema + `ChatIRChannel` interface + `ChatIRSeenTracker` 在 `@utlra/chat-ir`**：跨包共享的语义单点。
- **没有中间 IM 服务器**。Discord 入站直接进 agent 进程，落 `threads.json` / `identities.json` / `uploads/`，再 `seenTracker.track(...)` + 触发 `onAgentMessage` callback。
- **`outer/*` 业务代码（OuterBrain / OuterTools / PushLoop / OuterHeartbeat）**只 import `ChatIRChannel`（发消息）和 `ChatIRSeenTracker`（查反 loop / 新鲜度），不知道 Discord 存在。
- **入口 `packages/server/src/index.ts`** 是唯一应该 `new DiscordChannel(...)` / `new ChatIRSeenTracker(...)` 的地方——这是"具体实现注入"的边界。未配 Discord 时退化为 `NullChatIRChannel`，HTTP `POST /api/outer/inbound` 仍可用作离线调试入口。
- **渠道桥本身就是 `ChatIRChannel` 实现**——承担入站翻译 + 出站翻译 + chat IR 落库 + `seenTracker.track()` 4 个职责。**反 loop / 新鲜度的查询逻辑不在 channel 里**，由共享的 tracker 提供。

### 10.4 入站消息全链路（Discord）

```text
Discord MESSAGE_CREATE
  │
  ▼
DiscordChannel.onMessage（client.ts → handleDiscordMessage）
  ├─ filter 回声（bot 自己的消息 / recentBotSentMessageIds 命中）
  ├─ upsertDiscordIdentity → registry.upsert （进程内调用，写 identities.json）
  │   sid = "discord:user:<id>"  或 "idp:agent:discord-bot:<id>"
  ├─ getOrCreate ChatIR thread（threads.json 内存读 → 新建 ThreadRecord → save）
  ├─ 解析 parts:
  │   - mention.users → mention parts (target_sid 已 resolve)
  │   - msg.reference → quote part
  │   - msg.content → text part（替换 <@id> 为 @display_name）
  │   - msg.attachments → attachment parts
  │     · 默认下载到本地 ChatAssetStore（uploads/）→ URI = "asset:<uuid>"
  │     · 关闭下载时直接放 Discord CDN URL
  │   - msg.embeds → unknown part + text 摘要
  ├─ store.messages[threadId].push(MessageRecord) → saveThreads
  └─ onMessagePersisted (DiscordChannel 内部回调)
        ├─ seenTracker.track(threadId, { message_id, sender_sid })
        │   （响应式记录，供 OuterBrain countConsecutive / hasAnother 查询）
        ├─ filter 自己 + 非参与线程
        └─ 触发注入的 onAgentMessage(ChatIRInboundEvent)
              │
              ▼  ←─── 出 ChatIRChannel 边界，进入业务代码
        OuterBrain.handleInbound（只看 ChatIRInboundEvent）
              ├─ registry.buildPackForThread → IdentityContextPack
              ├─ loadThreads → serializeMessageForLlm（拼历史）
              ├─ LLM 调用，输出 StructuredReplyLlmPayload
              ├─ mergeStructuredReply → reply.v1
              ├─ validateReplyMentions
              └─ imClient.postMessage(threadId, { sender_sid, parts })
                    │
                    ▼  ←─── 回到 DiscordChannel 内部
              DiscordChannel.postMessage
                    ├─ mapper.getChannelId(threadId) → discord channel id
                    ├─ renderForDiscord（mention SID → <@native_id>；
                    │                    asset:<id> → 从 ChatAssetStore 取出 multipart 上传）
                    ├─ client.sendToChannel → Discord REST messages.create → discord_message_id
                    ├─ mapper.rememberBotSent（防回声）
                    ├─ store.messages[threadId].push(MessageRecord) → saveThreads（自己的回复也持久化）
                    └─ seenTracker.track(...)（自己消息也进 tracker，下一轮反 loop 看得到）
```

**抽象层划分**：业务代码只看 `ChatIRInboundEvent` 进、`postMessage(body)` 出；所有 Discord Gateway / REST / store 持久化细节都封在 `DiscordChannel` 内。

---

## 11. 跨 IM 身份统一现状（重要）

> **运行时权威（2026-07-16）**：[`doc/structurizr/IDENTITY-CROSS-CHANNEL.md`](../structurizr/IDENTITY-CROSS-CHANNEL.md)。  
> 本节保留历史背景；**同人事实源 = 双边确认状态机（或 admin）**，不是 LLM，也不是单方在新渠道自称。

### 11.1 用户最初的需求

> 同一个真实的人，在 Discord、飞书、Slack 等不同渠道发消息，应被识别为同一个身份；agent 应能跨渠道回忆 / 称呼 / 关联他。

### 11.2 schema 层 ✅ 完备；映射索引 ⏳

`IdentityRecord.bindings: ChannelBinding[]` 字段在（档案/反查视图）。  
**认知层权威结构**（ADL）：`channel_key → internal_sid`（`identityBindingIndex`）。

### 11.3 运行时层（升级目标）

**当前代码**仍多为 per-channel SID（`discord:user:…`），入站未统一 `resolve`。  

**目标行为**（ADL P0）：

1. 入站：`channel_key` → `resolve` → `internal_sid`
2. 跨渠道合并：仅 `identityLinkService` pending → 对端确认 → `linkMerge`
3. Agent 可发起 request / 查 status；**禁止**模型直接改映射

### 11.4 实现缺口（与 ADL §9 对齐）

| 缺口 | 含义 | 状态 |
|---|---|---|
| **identityBindingIndex** | `channel_key → sid` 落盘 + resolve/bind | ⏳ P0 |
| **identityLinkService** | 双边确认；唯一日常 commit | ⏳ P0 |
| **入站强制 resolve** | 各桥 / Facade | ⏳ P0 |
| **SID 迁移** | 渐进 `idp:user:<ulid>` | P0 过渡期可保留旧 sid 作值 |
| **channelConnectionRegistry + 飞书 N 连接** | 热插 | ⏳ P2（非身份核心） |

### 11.5 真实语义澄清

**当前实操语义**仍是 "per-channel identity"。  
**ADL 目标语义**：内部 sid 稳定；渠道键只在映射表；同人仅经双边确认。

只有以下两类 SID 长期渠道无关（按规划意图）：
- `idp:agent:assistant`（主助手）—— 由 `UTLRA_PRIMARY_AGENT_SID` 配置
- `idp:user:…`（人类内部身份，含 ULID）

---

## 12. 当前缺口与差距汇总

### 12.1 doc 写了、代码没实现（schema 小修补）

| # | 缺口 | 建议优先级 |
|---|---|---|
| 1 | `MessageRecord.ingested_at` | 低（仅排障）|
| 2 | `AssetRef.size_bytes / thumbnail_uri` | 中（数据可得，丢弃浪费）|
| 3 | `ThreadRecord.kind` 三元（dm/group/channel）| 中（影响默认 mention 必需性逻辑）|
| 4 | `MessagePart.location` | 低（无场景）|
| 5 | `provisional` 未验证身份标记 | 中（demo 模式靠 `ensureOpenDemoIdentity` hack 处理了）|

### 12.2 doc 没写、代码已实现（doc 倒欠）

本文档 v2 已补全：

- `UTLRA_IM_OPEN_DEMO` Demo 模式（§2.6）
- `UTLRA_PRIMARY_AGENT_SID` 主助手配置（§2.5）
- `presence` heartbeat / online sids（IM Plugin HTTP API）
- Discord 桥防回声机制（`recentBotSentMessageIds`）
- `[PRONOUNS]` 与 `[ROLES]` 序列化块（§2.7）
- `[MENTION_MAP]` 块在 IM Plugin 路由层动态附加（§2.7）

### 12.3 设计有、代码也没有（最大缺口）

**跨 IM 身份统一**运行时（映射索引 + 双边确认）——权威与分期见 [`structurizr/IDENTITY-CROSS-CHANNEL.md`](./structurizr/IDENTITY-CROSS-CHANNEL.md) §9。

---

## 13. 实测 SID 编码举例

| 主体 | 实测 SID 形式 | 渠道无关？ |
|---|---|---|
| 主助手 | `idp:agent:assistant`（默认）或 `UTLRA_PRIMARY_AGENT_SID` 配置值 | ✅ |
| Discord 人类用户 | `discord:user:1234567890` | ❌ |
| Discord 其他 bot | `idp:agent:discord-bot:1234567890` | ❌（虽有 idp 前缀，仍含渠道）|
| Web IM Demo 用户 | `idp:user:demo`（仅 demo 模式 seed）| ✅ |
| Web IM 任意 SID（open demo）| 任意字符串，首次出现自动登记 | 看调用方 |

**`idp:` 前缀的当前语义**：表示"我们注册表认领的"身份，但**不**意味着"渠道无关"。真正渠道无关的只有主助手。

**未来理想**：所有人类身份 SID 都用 `idp:01J8X...`（ULID），渠道前缀仅出现在 `bindings[]` 中。这要求合并机制先就绪（§11）。

---

## 14. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-04-04 | v1 初稿：身份子系统 + Message IR + Asset + LLM 序列化 + StructuredReply |
| 2026-04-04 | 增补 §2.6（v1）：多说话者模型；§4.1 与之一致 |
| 2026-04-04 | 与绿场里程碑对齐：第一方简易 IM 可作为 ChannelRenderer 参考实现 |
| **2026-05-11** | **v2 与代码现状对齐**：每节补"实现状态"与代码引用；增补 §2.5 主助手 SID 配置 / §2.6 Demo 开放模式 / §10 运行时物理形态 / §11 跨 IM 身份统一现状（重要）/ §12 缺口汇总 / §13 实测 SID 编码举例。明确 `bindings` 字段当前为占位，跨渠道合并未实施。 |
| 2026-05-14 | §3.5 时间字段约定（强制 ISO 8601 with offset）；§10.1 抽 `ChatIRSeenTracker`：channel 接口缩到 3 方法，反 loop / 新鲜度查询由共享 tracker 提供（chat IR runtime 与具体渠道实现解耦） |
| 2026-05-11 | §5.2.1 新增：`attach_asset_ids` 运行时语义（自动展开为 attachment parts + 来源合法性校验 + 静默剔除降级）。详细执行规则见独立子协议 `doc/protocols/inner-brain-deliverables.md` |
| 2026-07-16 | v2.1 §11 / TL;DR：跨渠道认同以 Structurizr [`IDENTITY-CROSS-CHANNEL.md`](./structurizr/IDENTITY-CROSS-CHANNEL.md) 为运行时权威（映射表 + 双边确认；Agent 不裁决） |

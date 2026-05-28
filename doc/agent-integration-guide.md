# Agent 集成 Chat IR 指南

**适用对象**：想接入本项目 chat IR 的 agent 实现者（你写了/打算写一个 agent runtime，希望它能在这套系统里收发消息）。
**前置阅读**：[`chat-ir-identity-design.md`](./chat-ir-identity-design.md) §1-§4（理解 schema） + §10（运行时拓扑）；本文档讲"具体怎么做"。
**参考实现**：`packages/server/src/outer/*`（OuterBrain 一整套 agent 业务代码）。

---

## 0. TL;DR

**agent 在 chat IR 里扮演什么角色**：

```text
            ChatIRChannel interface
                    ▲ ▼
  ┌─────────────────┴─┴───────────────────┐
  │ Agent Runtime（你写的）                  │
  │  - onAgentMessage(ev) 处理入站            │
  │  - 拉 IdentityContextPack 拼 prompt       │
  │  - LLM 输出 reply.v1                      │
  │  - 调 channel.postMessage 出站            │
  └────────────────────────────────────────┘
            ▲                ▲
   IdentityRegistry      LooseThreadStore
   （进程内单例）         （threads.json 读写工具）
```

**你需要做的事**（高层）：

1. 接受注入：`ChatIRChannel` 实例（由 `packages/server/src/index.ts` 选 Discord / Null / 别的实现）
2. 接受注入：`IdentityRegistry`、`loadThreads/saveThreads`、`ChatAssetStore`
3. 在 channel 构造时注册 `onAgentMessage` callback：拿到 `ChatIRInboundEvent` → 拼 prompt → 调 LLM → 校验 → `channel.postMessage`
4. **不要直接 import 任何具体 channel 实现**（如 `DiscordChannel`）——只 import 接口

**当前唯一外部 channel 实现**：`DiscordChannel`（`packages/discord-bridge/`）。
**兜底实现**：`NullChatIRChannel`（在 `packages/server/src/index.ts` 内置；未配 Discord 时使用，HTTP `/api/outer/roundtrip` 仍可用）。

### `@utlra/chat-ir` 的三种 import 路径

| 路径 | 内容 | 何时用 |
|---|---|---|
| `@utlra/chat-ir` | 全量（schemas + runtime + 工具 + 接口） | 默认；agent 业务代码 |
| `@utlra/chat-ir/schemas` | 仅 zod schema（**零 node 依赖**） | 浏览器 / Edge / Workers 环境想 parse 一条 `MessageRecord` |
| `@utlra/chat-ir/runtime` | `IdentityRegistry` / `ChatAssetStore` | 想细控依赖图（如 worker 子进程不需要 runtime） |

下文示例统一从 `@utlra/chat-ir` 引——本节顺序里你不需要纠结 subpath。

---

## 1. 你的身份（Agent Identity）

agent 在 chat IR 中是一条 `IdentityRecord`，`kind: "agent"`。

### 1.1 配置主助手 SID

```bash
# 必须配置；这是 agent 在 chat IR 里的稳定身份
export UTLRA_PRIMARY_AGENT_SID="idp:agent:your-bot-name"
# 或在 agent 进程启动时通过 UTLRA_AGENT_IM_SID 覆盖（优先级更高）
export UTLRA_AGENT_IM_SID="idp:agent:your-bot-name"
```

**约定**：
- SID 字符串可任意，但建议 `idp:agent:<name>` 形式
- 一个 agent 进程只对应一个 SID
- 必须在所有渠道桥配置里使用**同一个** SID（出站消息会以这个 SID 作为 `sender_sid`）

### 1.2 自动登记

`IdentityRegistry` 在 agent 进程启动时会自动 seed 一条主助手记录：

```json
{
  "schema": "identity.v1",
  "sid": "idp:agent:your-bot-name",
  "kind": "agent",
  "display_name": "Assistant",
  "aliases": ["助手"],
  "roles_in_tenant": ["assistant", "bot"],
  "bindings": [],
  "updated_at": "..."
}
```

如果想自定义 `display_name` / `aliases`，直接调 `registry.upsert(...)` 覆盖，或修改 `identities.json` 落盘文件。

---

## 2. ChatIRChannel 接口 + ChatIRSeenTracker（你看到的全部 IM 能力）

agent 业务代码面对两个抽象——一个管**传输**，一个管**对消息序列的查询**：

```typescript
// @utlra/chat-ir —— 只管传输
interface ChatIRChannel {
  start(): void;
  destroy(): void;
  postMessage(threadId: string, body: ChatIROutboundBody): Promise<void>;
}
// + 构造时注入的 onAgentMessage(ev: ChatIRInboundEvent) callback

// @utlra/chat-ir —— 对消息序列的运行时查询
class ChatIRSeenTracker {
  track(threadId, { message_id, sender_sid, mention_target_sids? }): void; // 桥在入站/出站各调一次
  countConsecutiveAgentMessages(threadId): number;          // 反 agent-loop
  hasAnotherAgentRepliedAfter(threadId, triggerId): boolean; // 新鲜度：仅「触发上被一并@的 agent」算抢答；独占@本 agent 时他人插话不掐断
}

interface ChatIROutboundBody {
  sender_sid: string;
  text?: string;
  parts?: unknown[];            // MessagePart[]
  parse_mentions?: boolean;     // 默认 true
}

interface ChatIRInboundEvent {
  threadId: string;
  senderSid: string;
  message: ChatIRInboundMessage;
  participantSids: string[];
}
```

**关键事实**：
- channel 实现负责**过滤回声**和**过滤非参与线程**——你收到的 `onAgentMessage` 事件假定都该处理
- channel 实现负责**写 chat IR store + 调 `seenTracker.track(...)`**——你调 `postMessage` 后消息自然会出现在 `threads.json`，tracker 里也会有记录
- `seenTracker.countConsecutiveAgentMessages` / `hasAnotherAgentRepliedAfter` 是**纯响应式**查询（纯内存，不发远端请求；进程重启后从空开始，所以重启不会被旧历史卡死）
- channel 与 tracker 都是进程内单例，**由入口（`packages/server/src/index.ts`）统一构造并同时注入给 channel 实现与 agent 业务代码**——所有 channel 共享同一个 tracker

---

## 3. 消费：入站事件 + 上下文构造

### 3.0 入站合同：什么消息会触发 `onAgentMessage`，什么不会

这是你写 agent 时最先要搞清楚的事——**渠道桥替你过滤了什么，没替你过滤什么**。

| 情况 | 是否触发 `onAgentMessage` | 谁过滤 |
|---|---|---|
| bot（你自己）发出去的消息从渠道又推回来 | ❌ 不触发 | 渠道桥（双层回声防护：bot user id + outbound 记录） |
| 来自非白名单 guild / workspace 的消息 | ❌ 不触发 | 渠道桥（按 `guildAllowlist` 等配置） |
| 消息 parts 为空（如只有一个表情 reaction、没文本/附件） | ❌ 不触发 | 渠道桥（`parts.length === 0` 直接丢） |
| **DM（1:1）任意非空消息** | ✅ 触发 | — |
| **群里任意一条非空消息**（哪怕没 @ 你） | ✅ **触发** | — |
| 群里 @ 你的消息 | ✅ 触发 | — |
| 群里 @ 别人但没 @ 你的消息 | ✅ **仍然触发** | — |
| 别的 agent / bot 在群里说话 | ✅ 触发（按 SID 命名约定，sender 是 `idp:agent:...`） | — |

**核心结论**：群里所有人说什么 agent 都会"听到"。**要不要回**是 agent 业务代码自己判断。

参考 `OuterBrain` 的实现（`packages/server/src/outer/inbound-policy.ts`、`outer-brain.ts`）：

- DM 永远回复（除非内容是 `[图片]` `[表情]` 这种占位符）
- 群里：默认只在被 @ 时回复；可选 LLM "SPEAK/SILENT" 判断主动接话；多 agent 同处一群时还会做"别的 agent 已经接话了我就闭嘴"判断（见 §4.3）

如果你接受默认策略，可以直接复用 `OuterBrain`。如果你要自定义参与逻辑，看 §3.5。

### 3.1 注册 onAgentMessage

```typescript
import type { ChatIRChannel, ChatIRSeenTracker, ChatIRInboundEvent } from '@utlra/chat-ir';

class MyAgentRuntime {
  constructor(
    private channel: ChatIRChannel,
    private seenTracker: ChatIRSeenTracker,
    /* ... */
  ) {}

  async handleInbound(ev: ChatIRInboundEvent): Promise<void> {
    // 1. 反 agent-loop 检查（基于 tracker，纯内存）
    if (this.seenTracker.countConsecutiveAgentMessages(ev.threadId) >= MAX_CHAIN) return;

    // 2. 拼 prompt（见 §3.2 / §3.3）
    // 3. 调 LLM
    // 4. 校验 + 出站（见 §4，发送前可再调 seenTracker.hasAnotherAgentRepliedAfter 做新鲜度检查）
  }
}
```

`onAgentMessage` 在 channel 构造时注入；tracker 由入口创建并同时给 channel 与 agent runtime：

```typescript
// 在 server/index.ts 内：
const seenTracker = new ChatIRSeenTracker({
  selfAgentSid: agentSid,
  identityRegistry: registry,
});

const channel = new DiscordChannel({
  /* ... */
  seenTracker,                  // channel 在入站/出站调 track()
  onAgentMessage: (ev) => agentRuntime.handleInbound(ev),
});

const agentRuntime = new MyAgentRuntime(channel, seenTracker /* ... */);
```

### 3.2 拉身份知识包

不再有 HTTP API。**直接调注入的 `IdentityRegistry`**：

```typescript
import { serializeIdentityPack, type IdentityRegistry } from '@utlra/chat-ir';

function buildIdentityPack(
  registry: IdentityRegistry,
  threadId: string,
  participantSids: string[],
  tenantId: string,
  threadKind: 'dm' | 'group',
): string {
  // 注意：位置参数（不是 object 参数）；自动包含 agentSid 进 participants
  const pack = registry.packForThread(threadId, tenantId, threadKind, participantSids);
  return serializeIdentityPack(pack);
}
```

**输出形如**：

```text
[SELF]
sid=idp:agent:assistant name=Assistant kind=agent

[PARTICIPANTS]
sid=discord:user:123 name=张三 kind=human aliases=
sid=idp:agent:assistant name=Assistant kind=agent aliases=助手

[ROLES]
discord:user:123: member
idp:agent:assistant: assistant,bot

[THREAD]
thread_id=... tenant=default kind=group

[PRONOUNS]
「你」= 本栈主助手（上列 [SELF]，sid=idp:agent:assistant）；「我」= 该条消息头 from:sid ...
```

直接拼到 system prompt 最前面。每轮都调一次（参与者可能变化）。

### 3.3 拉线程历史

```typescript
import { serializeMessageForLlm, type LooseThreadStore } from '@utlra/chat-ir';

function buildHistory(
  loadThreads: () => LooseThreadStore,
  registry: IdentityRegistry,
  threadId: string,
  limit: number,
): string {
  const store = loadThreads();
  const raw = (store.messages[threadId] ?? []) as MessageRecord[];
  const recent = raw.slice(-limit);
  return recent
    .map((m) => {
      const sender = registry.get(m.sender_sid);
      return serializeMessageForLlm(
        m,
        sender?.display_name ?? 'unknown',
        sender?.kind ?? 'human',
      );
    })
    .join('\n');
}
```

`serializeMessageForLlm` 输出格式：

```text
[from:sid:discord:user:123|张三(kind:human)|今天 14:32（3分钟前）]
@助手 这个 bug 你看一下
```

完整规则见 `chat-ir-identity-design.md` §4.1。

### 3.4 判断"该不该回"：threadKind / isMentionAgent / mentionsOthers

`ChatIRInboundEvent` 故意保持极简——只给原始事实，不内置参与策略。**判断逻辑由 agent 业务代码做**。

参考实现 `OuterBrain.resolveThreadMeta`（`packages/server/src/outer/outer-brain.ts`）：

```typescript
import type { ChatIRInboundEvent, MessagePart, LooseThreadStore } from '@utlra/chat-ir';

interface InboundMeta {
  threadKind: 'dm' | 'group';
  /** DM 永远 true；group 中只有 parts 含 mention 指向 agentSid 才 true */
  isMentionAgent: boolean;
  /** 群里 @ 了别人但没 @ agent —— 适合"不插嘴" */
  mentionsOthers: boolean;
}

function resolveMeta(
  ev: ChatIRInboundEvent,
  agentSid: string,
  loadThreads: () => LooseThreadStore,
): InboundMeta {
  // 1. threadKind: 优先看 participantSids；降级查 threads.json
  let threadKind: 'dm' | 'group' = ev.participantSids.length >= 3 ? 'group' : 'dm';
  if (threadKind === 'dm') {
    const store = loadThreads();
    const tr = store.threads.find(
      (t) => (t as { thread_id?: string }).thread_id === ev.threadId,
    ) as { participant_sids?: string[] } | undefined;
    if (tr?.participant_sids && tr.participant_sids.length >= 3) {
      threadKind = 'group';
    }
  }

  // 2. parts 扫 mention
  const mentionParts = ev.message.parts.filter((p) => p.type === 'mention') as Array<
    MessagePart & { type: 'mention'; target_sid: string }
  >;
  const isMentionAgent =
    threadKind === 'dm' || mentionParts.some((p) => p.target_sid === agentSid);
  const mentionsOthers =
    !isMentionAgent && mentionParts.some((p) => p.target_sid !== agentSid);

  return { threadKind, isMentionAgent, mentionsOthers };
}
```

**推荐参与策略**（与 `OuterBrain` 默认一致）：

```typescript
async function handleInbound(ev: ChatIRInboundEvent) {
  const meta = resolveMeta(ev, agentSid, loadThreads);

  // 反 agent-loop（防止两 bot 互相 ping）—— 用注入的 seenTracker
  if (seenTracker.countConsecutiveAgentMessages(ev.threadId) >= 3) return;

  // DM：永远回（除非占位符）
  if (meta.threadKind === 'dm') {
    if (isPlaceholderContent(ev.message)) return;
    // → 正常处理
  } else {
    // 群里：默认只在被 @ 时回
    if (!meta.isMentionAgent) return;
    // 进阶：被 @ 了，但触发后被另一个 agent 抢答了 → 放弃
    if (seenTracker.hasAnotherAgentRepliedAfter(ev.threadId, ev.message.message_id)) return;
  }

  // ... 走 LLM 拼 prompt / 出站
}
```

---

## 4. 产出：LLM → reply.v1 → channel.postMessage

### 4.1 LLM 输出契约：`StructuredReplyLlmPayload`

**让 LLM 输出严格的 JSON**（不是自由文本）：

```typescript
{
  text: string;                          // 主文案；可带 markdown
  mention_sids?: string[];               // 顶栏 @ 列表（用 SID，不是 native id）
  reply_to_message_id?: string;          // 引用某条消息（thread-level reply）
  attach_asset_ids?: string[];           // 附件 asset id 列表
  parts?: MessagePart[];                 // 富媒体；与入站 parts 同形
}
```

**System Prompt 必须明确告诉 LLM**：
- 只输出 JSON，无任何前后缀文本
- `mention_sids` 必须来自 `[PARTICIPANTS]` 中的 SID
- 不要输出渠道私有 wire（`<@id>`、`<at>`），渠道桥会自动渲染

### 4.2 解析 + 校验

```typescript
import {
  parseJsonObjectFromLlmText,
  StructuredReplyLlmPayloadSchema,
  mergeStructuredReply,
  validateReplyMentions,
} from '@utlra/chat-ir';

const obj = parseJsonObjectFromLlmText(llmRawOutput);
const payload = StructuredReplyLlmPayloadSchema.parse(obj);
const reply = mergeStructuredReply(threadId, payload);

const allowed = new Set([selfSid, ...participantSids]);
const v = validateReplyMentions(reply, allowed);
if (!v.ok) {
  // 退路：要么 reject，要么把非法 SID 替换为 text
  console.warn(`reply 校验失败: ${v.error}`);
}
```

### 4.3 发出

```typescript
// 新鲜度检查（OuterBrain 经 makeFreshCheck 注入 outer-tools / conversation-loop）：
// - 触发仅 @ 本 agent → 不因大群里其它 agent 插话而放弃
// - 触发 @ 本 agent + 其它 agent → 仅那些 agent 的后续发言算抢答
// - 无 mention 元数据 → 回退为 idp:agent:/agent: 前缀 peer（不含 webchat 马甲）
if (this.seenTracker.hasAnotherAgentRepliedAfter(ev.threadId, ev.message.message_id)) {
  return;
}

await this.channel.postMessage(ev.threadId, {
  sender_sid: agentSid,
  text: reply.text,
  parts: reply.parts ?? undefined,
});
```

**两种发送形式**：

| 模式 | body 字段 | 适用 |
|---|---|---|
| **纯文本 + 自动 @ 解析** | `{ text, parse_mentions: true }` | 简单回复，channel 会用 `plainTextToPartsWithMentions(text, registry)` 把 `@张三` 转换为 mention parts |
| **完整 parts** | `{ parts: [...] }` | 富媒体 / 精确控制 mention 位置 |

同时给 `text` 和 `parts` 时：**`parts` 优先**；`text` 仅作为 channel 渲染时的 fallback。

### 4.4 文件 / 附件：接收与发送

Chat IR 的附件统一用 `MessagePart` 的 `attachment` 类型表达：

```typescript
{
  type: 'attachment',
  asset_ref: {
    kind: 'image' | 'video' | 'audio' | 'file',
    uri: string,    // 见下文两种 scheme
    mime?: string,
    name?: string,
  },
}
```

`asset_ref.uri` 有两种合法形式：

| Scheme | 含义 | 出现场景 |
|---|---|---|
| `asset:<uuid>` | **本地**存储——通过注入的 `ChatAssetStore` 落地、用 id 引用 | 渠道桥入站默认下载外部 CDN 后写入；agent 出站想发本地文件 |
| `http(s)://...` | 外部直链 | 渠道桥若关闭下载（`DISCORD_BRIDGE_DOWNLOAD_ATTACHMENTS=0`）会直接放原 CDN URL；agent 想发已有的网图也用这个 |

> ⚠️ **CDN URL 通常有时效**（Discord 几小时后 404，飞书更短）。agent 想"晚点再看"或反复用，**应该先把外链下载到 `ChatAssetStore`**，再用 `asset:<id>` 引用。

#### 接收附件

```typescript
import type { ChatAssetStore, MessagePart } from '@utlra/chat-ir';

async function readInboundAttachments(
  ev: ChatIRInboundEvent,
  assetStore: ChatAssetStore,
): Promise<Array<{ kind: string; mime: string; name: string; buffer: Buffer }>> {
  const out: Array<{ kind: string; mime: string; name: string; buffer: Buffer }> = [];

  for (const part of ev.message.parts as MessagePart[]) {
    if (part.type !== 'attachment') continue;
    const { uri, kind, mime, name } = part.asset_ref;

    if (uri.startsWith('asset:')) {
      const id = uri.slice('asset:'.length);
      const got = assetStore.get(id);   // { meta, buffer } | null
      if (got) out.push({ kind, mime: got.meta.mime, name: got.meta.name, buffer: got.buffer });
    } else if (uri.startsWith('http://') || uri.startsWith('https://')) {
      // 外链——按需自己下载；注意可能已过期
      const r = await fetch(uri);
      if (r.ok) {
        out.push({
          kind,
          mime: mime ?? r.headers.get('content-type') ?? 'application/octet-stream',
          name: name ?? uri.split('/').pop() ?? 'file',
          buffer: Buffer.from(await r.arrayBuffer()),
        });
      }
    }
  }
  return out;
}
```

#### 发送附件

```typescript
import type { ChatAssetStore, MessagePart } from '@utlra/chat-ir';

// 1. 把本地 buffer 存进 store，拿到 asset id
const saved = assetStore.save(pngBuffer, 'image/png', 'screenshot.png');
//   saved.id = 'a1b2c3...uuid...'

// 2. 组装 parts，出站
await channel.postMessage(threadId, {
  sender_sid: agentSid,
  text: '这是刚才的截图：',                          // 可选，作为附图说明
  parts: [
    { type: 'text', text: '这是刚才的截图：' },
    {
      type: 'attachment',
      asset_ref: {
        kind: 'image',
        uri: `asset:${saved.id}`,
        mime: saved.mime,
        name: saved.name,
      },
    },
  ] as MessagePart[],
});
```

渠道桥会自动通过 `assetStore.get(id)` 取回 buffer，multipart 上传到目标平台。

#### 发送外链（不用本地存储）

```typescript
await channel.postMessage(threadId, {
  sender_sid: agentSid,
  parts: [{
    type: 'attachment',
    asset_ref: {
      kind: 'image',
      uri: 'https://example.com/avatar.png',
      mime: 'image/png',
      name: 'avatar.png',
    },
  }] as MessagePart[],
});
```

Discord 渠道会把外链放进 message content 让 Discord 自己抓预览；其他渠道按实现各异。

#### 几种文件 kind 的判断

`asset_ref.kind` 是 chat IR 的统一分类：

| kind | mime 示例 |
|---|---|
| `image` | `image/png` / `image/jpeg` / `image/webp` / `image/gif` |
| `video` | `video/mp4` |
| `audio` | `audio/mpeg` / `audio/ogg` |
| `file` | 其他（PDF / ZIP / 文本 / ...） |

如果你自己写 kind 推断逻辑，可参考 `packages/discord-bridge/src/attachment.ts` 的 `attachmentKindFromMime`。

### 4.5 `attach_asset_ids`：LLM 视角的"简洁附件"语法糖

LLM 不必在 reply 里手写完整的 `MessagePart.attachment`——直接把裸 UUID 塞进 `attach_asset_ids` 即可，运行时会展开为 part：

```jsonc
// LLM 输出
{
  "text": "这是上次的报告：",
  "attach_asset_ids": ["a1b2c3d4-...", "e5f6g7h8-..."]
}
```

```ts
// 运行时（出站前）行为，等价于：
reply.parts = [
  ...(reply.parts ?? []),
  ...attach_asset_ids
    .map(id => assetStore.get(id))
    .filter(Boolean)
    .map(({ meta }) => ({
      type: 'attachment',
      asset_ref: {
        kind: inferKindFromMime(meta.mime),
        uri: `asset:${meta.id}`,
        mime: meta.mime,
        name: meta.name,
      },
    })),
];
```

**关键规则**（详见 `chat-ir-identity-design.md §5.2.1` 与 `doc/protocols/inner-brain-deliverables.md §6.4`）：

1. **裸 UUID**：`attach_asset_ids` 协议层定义为不带 `asset:` 前缀的 UUID 字符串；LLM 若误写 `asset:xxx`，运行时自动 strip 前缀。
2. **来源合法性校验**：每个 id **必须**在"允许集合"中可解 ——
   - 当前 `inner-status.v1.deliverables[].asset_id`（内脑刚跑完的产物）
   - 当前 thread **入站**消息曾经携带的 asset_id
   - 当次任务上下文 pack 注入的 asset_id
3. **静默降级**：不合法的 id 静默剔除（不阻断回复），warning 写入 `<workDir>/.run/deliverables.log`。
4. **不去重**：和 `parts[].attachment` 共存，重复发同一 asset 是合法行为（LLM 决定）。

### 4.6 内脑产物如何让 LLM "看见并 attach"

**端到端链路**（agent 实现者通常不需要手写中间任何一步——系统层全包了）：

```
内脑里                                外脑系统层（onExit DONE 分支）         LLM
─────                                ────────────────────────────         ───
register_deliverable("a.md")  ─▶  读 COMPLETE.deliverables: string[]
                                   │
                                   ├─ 对每条路径调 assetStore.save
                                   ├─ 写 inner-status.v1.deliverables[]
                                   └─ 自动 postMessage（text + attachment parts）
                                                              │
                                                              ▼
                                                      read_inner_status ──▶ deliverables[].asset_id
                                                                            │
                                                                            ▼
                                                                    "再发一次报告" → attach_asset_ids: [...]
```

**对 agent 实现者意味着**：

- 不要在外脑代码里 `fs.readdirSync(workDir)` 扫文件名拼 text——这种做法在 v1 之后**不合规**；
- 不要构造"假附件"（`text: "📎 文件：a.md"`）——必须用 `MessagePart.attachment`；
- LLM 若想"过几轮再补发"：从 `read_inner_status` 拿到 `deliverables[].asset_id`，放进 `attach_asset_ids`，就完事；
- 如果要绕开 `attach_asset_ids` 直接调工具发：用 `send_file({ thread_id, asset_ids })`（v1 起 `file_paths` 参数已废弃）。

完整规范见 [`doc/protocols/inner-brain-deliverables.md`](./protocols/inner-brain-deliverables.md)。

---

## 5. 边界 / 错误处理

### 5.1 Channel 不可用

`NullChatIRChannel` 在未配 Discord 时启用：
- `postMessage` 仅打日志，不抛错
- `count*` / `hasAnother*` 始终返回 0 / false
- 不会触发 `onAgentMessage`（没有入站源）

HTTP `/api/outer/roundtrip` 不依赖 channel 出站，可作离线调试入口（直接读写 threads.json 即可）。

### 5.2 LLM 输出非法 SID

`validateReplyMentions` 返回 `ok: false`。处理选项：
- **拒发**：要求 LLM 重新生成（贵）
- **降级为纯文本**：丢掉 mention，只发 `text`（推荐）
- **二次解析**：用 `registry.resolveMentionToken(label)` 尝试把 label 反查为 SID

### 5.3 LLM 输出非 JSON

`parseJsonObjectFromLlmText` 支持 `` ```json `` 围栏和裸对象，但仍可能失败。建议：
- 包 try/catch
- 失败时发一条 `text: "[模型输出解析失败]"` 的 fallback 回复
- 写日志便于 prompt 调优

### 5.4 多线程并发

多个线程的消息会**并发**调用 `onAgentMessage`。如果你的 LLM 调用是有状态的（如共享 mem9 写入），自己做线程间隔离 / 串行化。

### 5.5 群聊中的"主动参与"

入站合同与"默认参与策略"已在 §3.0 / §3.4 说明，本节只补两个**慎用提醒**：

- **关键词自动接话**：在 `handleInbound` 里加"消息含 keyword 就接话"是可行的，但**多个 agent 同处一群时都积极主动会互呛**。务必配合 `seenTracker.hasAnotherAgentRepliedAfter` 做新鲜度检查，并设主动发言冷却（参考 `participation-state.ts`）。
- **LLM SPEAK/SILENT 判断**：再加一层 LLM 二分决策（每条群消息都问一下"该不该接话"）能进一步降低误参与，但成本翻倍。`OuterBrain` 默认开启（`UTLRA_OUTER_PARTICIPATION_LLM=0` 可关）。

---

## 6. 必读约定

### 6.1 业务代码只依赖接口

```typescript
// 业务代码（处理消息、调 LLM、发回复等）——只 import interface / 类
import type { ChatIRChannel, ChatIRSeenTracker, ChatIRInboundEvent } from '@utlra/chat-ir';

function processInbound(
  channel: ChatIRChannel,
  seenTracker: ChatIRSeenTracker,
  ev: ChatIRInboundEvent,
) {
  // channel.postMessage —— 发消息
  // seenTracker.countConsecutiveAgentMessages / hasAnotherAgentRepliedAfter —— 反 loop / 新鲜度
  // 不知道也不在乎 channel 背后是 Discord / 飞书 / 内存测试
}

// 入口（main / index.ts）——唯一应该 new 具体实现的地方
import { DiscordChannel, loadDiscordBridgeConfig } from '@utlra/discord-bridge';

const channel: ChatIRChannel = discordCfg
  ? new DiscordChannel({ /* ... */ })
  : new NullChatIRChannel();
channel.start();
```

未来要换 transport（in-memory / 飞书 / 别的）只动入口一处。

### 6.2 出站 `sender_sid` 必须 = `agentSid`

否则 channel 实现可能拒收 / 写错身份。

### 6.3 不要发明 SID

LLM 出站时只能引用 `[PARTICIPANTS]` 块里出现过的 SID。如果你需要 mention 一个新出现的人，先让 channel 桥在入站时把他 upsert 进 Registry。

### 6.4 不要假设 thread.kind 只有 dm/group

未来可能扩成 dm/group/channel/space。代码里用 switch + default 留扩展点。

### 6.5 读 thread store 用工具函数

```typescript
import {
  findThread,
  findExistingDmThread,
  ensureThreadShell,
} from '@utlra/chat-ir';
```

不要自己 parse `threads.json` 原始 JSON——schema 演进时会破坏。

### 6.6 时间字段一律用 ISO 8601 with offset

任何产生 `MessageRecord` / `ThreadRecord` / `IdentityRecord` 的时间字段（`sent_at` / `created_at` / `updated_at`）只允许：

```typescript
sent_at: new Date().toISOString(),                     // ✅ 当前时刻
sent_at: new Date(epochMillis).toISOString(),          // ✅ 来自渠道的 epoch
```

schema (`@utlra/chat-ir/schemas`) 已用 `z.string().datetime({ offset: true })` 强制，写错会立刻 parse 失败。

完整规则与原因见 [`chat-ir-identity-design.md §3.5`](./chat-ir-identity-design.md#35-时间字段约定强制-iso-8601-with-offset)。

---

## 7. 验证清单（联调用）

按顺序勾掉：

- [ ] 配置 `.env`：`DISCORD_BOT_TOKEN` + `UTLRA_AGENT_IM_SID`
- [ ] agent 启动后日志显示 `[discord-channel] started as ...`
- [ ] 在 Discord 给 bot 发一条 DM 或在群里 @bot
- [ ] agent 日志看到 `[discord-bridge] ← discord ... → chat-ir ...`
- [ ] `onAgentMessage` 被触发，日志看到入参
- [ ] LLM 输出能被解析为合法 `reply.v1`
- [ ] `channel.postMessage` 完成，Discord 看到 agent 回复
- [ ] 重启 agent 后 `<DATA_ROOT>/chat/threads.json` 历史还在

**HTTP 调试入口**（不依赖 channel 上线）：

- [ ] `POST http://127.0.0.1:8787/api/outer/roundtrip` 用 `{ text, thread_id, sender_sid, workspace_id }` 触发一次端到端 roundtrip（直接读写 store，不走 Discord）

---

## 8. 进一步阅读

| 文档 | 内容 |
|---|---|
| [`chat-ir-identity-design.md`](./chat-ir-identity-design.md) | 完整 schema + 身份子系统 + 现状汇总 |
| [`channel-bridge-guide.md`](./channel-bridge-guide.md) | 想接新外部 IM 平台（飞书 / Slack / ...）？看这个 |
| [`inner-outer-protocol.md`](./inner-outer-protocol.md) | OuterBrain 与内脑（Pi-mono）之间的 roundtrip 契约 |
| [`protocols/inner-brain-deliverables.md`](./protocols/inner-brain-deliverables.md) | 内脑产物如何回传给用户（asset 化 + `attach_asset_ids` 单一权威路径） |

---

## 修订记录

| 日期 | 说明 |
|------|------|
| 2026-05-11 | v1 初稿（基于 IM Server / WS） |
| 2026-05-12 | v2 删 IM Server：agent 直接面对 `ChatIRChannel`，所有数据访问改为进程内调用 `IdentityRegistry` / `loadThreads` 等 |
| 2026-05-13 | v2.1 §3.0 入站合同表 + §3.4 参与判断范例 + §4.4 附件发送/接收专章；修正 `packForThread` API 签名；§0 加 chat-ir subpath imports 表 |
| 2026-05-14 | v2.2 抽 `ChatIRSeenTracker`：channel 接口缩到 3 方法；反 loop / 新鲜度查询统一由共享 tracker 提供，由入口构造并同时注入给 channel 与 OuterBrain |
| 2026-05-11 | v2.3 新增 §4.5 `attach_asset_ids` 语法糖 + §4.6 内脑产物 attach 链路；废弃 `listDeliverables` 全扫与 `send_file({ file_paths })` 旧签名（详见 `doc/protocols/inner-brain-deliverables.md`） |

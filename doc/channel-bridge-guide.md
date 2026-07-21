# 渠道桥（Channel Bridge）实现指南

**适用对象**：想把新**外部 IM 平台**（飞书 / Slack / 钉钉 / Telegram / WhatsApp / 微信 等）接入本项目 chat IR 的实现者。
**前置阅读**：[`chat-ir-identity-design.md`](./chat-ir-identity-design.md) §1-§6（理解 schema） + §10（运行时拓扑）；[`agent-integration-guide.md`](./agent-integration-guide.md)（理解 agent 视角）。
**参考实现**：`packages/discord-bridge/`（Discord 渠道桥，约 700 行，可作模板）。

---

## 0. TL;DR

**渠道桥的职责**：**实现 `ChatIRChannel` 接口**，做外部 IM 协议与 chat IR 之间的**双向翻译**，并把消息落进 agent 进程内的 chat IR store。

```text
外部 IM 平台              你的渠道桥（implements ChatIRChannel）           agent (outer/*)
─────────────             ────────────────────────────────────             ────────────────
                          ┌────────────────────────────────┐
事件接收 ────────────────►│ inbound:                       │
（Gateway / webhook /     │  1. 过滤回声                    │
  RTM / Server-Sent...）  │  2. upsert 身份 → IdentityRegistry│
                          │  3. 找/建 thread → threads.json │
                          │  4. parts 解析                  │
                          │  5. 写 MessageRecord            │
                          │  6. seenTracker.track(...) + onAgentMessage────► OuterBrain.handleInbound
                          ├────────────────────────────────┤
REST 发送 ◄───────────────│ postMessage(threadId, body):    │◄──── outer/* 调 channel.postMessage
（messages.create / 等）  │  1. thread → channel id         │
                          │  2. 渲染 reply parts → 渠道 wire │
                          │  3. 调外部 REST                 │
                          │  4. 写 MessageRecord（自己也持久化）│
                          │  5. rememberBotSent（防回声）    │
                          │  6. seenTracker.track(...)       │
                          └────────────────────────────────┘
```

**你要做的 7 件事**：

1. 实现 `ChatIRChannel` 的 3 个方法（`start` / `destroy` / `postMessage`）
2. 维护 `channel_native_id ↔ thread_id` 映射（落盘）
3. 入站：把外部消息翻译成 `MessageRecord`，写入注入的 `threads.json`
4. 出站：把 `parts` 渲染成外部协议 wire，调外部 REST
5. 维护身份：每次见到新用户调注入的 `IdentityRegistry.upsert`
6. 附件：通过注入的 `ChatAssetStore` 落地外部 CDN
7. 回声防护 + tracker 同步：记录自己刚发出去的 message_id 防 echo；**入站落库后 + 出站发送成功后各调一次 `seenTracker.track(threadId, { message_id, sender_sid })`**（反 loop / 新鲜度查询由 `ChatIRSeenTracker` 统一提供，不再每个桥各写一份）

**没有 IM Server，没有 HTTP/WS 中间层**——所有操作都是进程内的纯函数调用。

---

## 1. 进程拓扑

**所有渠道桥都寄居在 agent 主进程内**（与 `DiscordChannel` 相同）。

```text
agent 进程（packages/server, port 8787）
├─ OuterBrain / PushLoop / OuterHeartbeat
├─ IdentityRegistry / ChatAssetStore / threads.json
└─ ChatIRChannel 实现（你写的桥；与 DiscordChannel 平级）
   ├─ 外部 IM 客户端（Gateway / webhook 路由）
   ├─ inbound: 外部事件 → 写 store → callback
   └─ outbound: postMessage → 渲染 → 外部 REST + 写 store
```

**优点**：
- 部署简单（一个进程）
- 与 agent 共享 `IdentityRegistry` / `ChatAssetStore` / `threads.json`
- 同步调用 = 没有跨进程 HTTP/WS 序列化开销

**未来若需独立部署**：把 chat IR store 提到独立服务（gRPC / HTTP）后，渠道桥本身仍可不变——这是更深的演进，目前不在路线图。

---

## 2. SID 编码约定（最重要）

### 2.1 当前编码规则

每个渠道桥负责把外部 native id 编码成 SID。**约定的命名空间**：

| 渠道 | 人类用户 SID | 其他 bot SID |
|---|---|---|
| Discord | `discord:user:<native_id>` | `idp:agent:discord-bot:<native_id>` |
| Slack | `slack:user:<U12345>` | `idp:agent:slack-bot:<B67890>` |
| 飞书 | `feishu:user:<ou_xxx>` | `idp:agent:feishu-bot:<...>` |
| 钉钉 | `dingtalk:user:<...>` | `idp:agent:dingtalk-bot:<...>` |
| Telegram | `telegram:user:<...>` | `idp:agent:telegram-bot:<...>` |
| 微信 | `wechat:user:<openid>` | `idp:agent:wechat-bot:<...>` |

**规则**：
- 普通人 → `<channel>:user:<native_id>`
- 其他 bot → `idp:agent:<channel>-bot:<native_id>`（带 `idp:agent:` 前缀，让 OuterBrain 正则 `/^(idp:)?agent:/i` 命中）
- 本助手（你自己的 agent）→ **永远用 `agentSid`**（如 `idp:agent:assistant`），不要用渠道编码

### 2.2 ⚠️ 跨渠道身份不会自动统一

> 同一个真实的人在 Discord 和飞书发消息，会得到**两条独立的 SID**（`discord:user:xxx` 和 `feishu:user:yyy`），**不会自动合并**。
>
> `IdentityRecord.bindings[]` 字段能存"一条 SID 对多个渠道"的映射，但**当前没有合并 API**——你的桥只往自己渠道那一格写。

详见 [`chat-ir-identity-design.md`](./chat-ir-identity-design.md) §11。

**你写桥的责任**：只管自己渠道的 SID 编码，**不要尝试**跨渠道猜测身份。合并是平台层的事，未来由专门的 link API 处理。

---

## 3. 渠道桥骨架（按 `DiscordChannel` 模板）

```typescript
import {
  MessageRecordSchema,
  plainTextToPartsWithMentions,
  type ChatAssetStore,
  type ChatIRChannel,
  type ChatIRInboundEvent,
  type ChatIROutboundBody,
  type ChatIRSeenTracker,
  type IdentityRegistry,
  type LooseThreadStore,
} from '@utlra/chat-ir';

export interface FeishuChannelOptions {
  config: FeishuBridgeConfig;
  agentSid: string;
  dataRoot: string;
  registry: IdentityRegistry;
  assetStore: ChatAssetStore;
  loadThreads: () => LooseThreadStore;
  saveThreads: (data: LooseThreadStore) => void;
  /** 由入口注入：入站落库后 + 出站发送后必须调 track() */
  seenTracker: ChatIRSeenTracker;
  onAgentMessage: (ev: ChatIRInboundEvent) => Promise<void>;
}

export class FeishuChannel implements ChatIRChannel {
  constructor(private readonly opts: FeishuChannelOptions) {
    // 实例化外部客户端，注册事件回调
  }

  start(): void { /* 启动 Gateway / 启动 webhook server */ }
  destroy(): void { /* 关连接 / 关 server */ }

  async postMessage(threadId: string, body: ChatIROutboundBody): Promise<void> {
    // 1. thread → 外部 channel/chat id
    // 2. 渲染 parts → 飞书消息体
    // 3. 调飞书 REST
    // 4. 写 MessageRecord 到 store
    // 5. rememberBotSent（防回声）
    // 6. seenTracker.track(threadId, { message_id, sender_sid }) ← 必须！
  }

  // 内部：外部事件回调
  private async handleInbound(event: FeishuMessageEvent) {
    // 详见 §4。落库 + seenTracker.track(...) 后再触发 onAgentMessage。
  }
}
```

> 桥**不再自己实现** `countConsecutiveAgentMessages` / `hasAnotherAgentRepliedAfter`——
> 这两个查询已抽到 `ChatIRSeenTracker`（`@utlra/chat-ir/seen-tracker.ts`），
> 由入口构造一个进程内单例，同时给所有桥实例和 agent 业务用。桥只负责喂数据进 tracker。

完整范本：`packages/discord-bridge/src/discord-channel.ts`。

---

## 4. 入站方向（外部 → chat IR）

### 4.0 入站过滤合同（adapter 对 agent 的承诺）

**核心原则**：渠道桥过滤"显然不该送上去的"，**不替 agent 做参与决策**。

| 必须过滤掉（不触发 onAgentMessage） | 必须放行（即使看起来"agent 不一定想要"） |
|---|---|
| sender 是 bot 自己（按 platform user id 判断） | 群里别人之间的对话（agent 没被 @） |
| outbound 记录命中（自己出站后被回推） | 引用了别人消息的（reply / quote） |
| 配置黑/白名单外的 guild / workspace | 别的 agent / bot 发的（按 SID 命名约定） |
| parts 为空的消息（纯 reaction、纯系统通知） | 没文本但有附件的（附件本身就是 part） |

**为什么这样划分**：

- "参与决策"（DM / 群里被 @ / 群里主动接话）应该由 agent 业务代码做——它能看到完整 prompt 上下文、参与状态、参与频率限额等。渠道桥不该越权。
- "回声防护"必须渠道桥做——agent 拿不到 platform user id，没法识别"这是我自己刚发的"。
- "空 parts 过滤"防止 agent 被一堆无意义事件吵到。

参考 `packages/discord-bridge/src/inbound.ts` 顶部的 4 道闸：

```typescript
if (msg.author.id === deps.botUserId) return false;          // 我自己
if (deps.mapper.isBotEcho(msg.id)) return false;             // 我刚发过
if (!guildAllowlist.includes(guildId)) return false;         // 黑/白名单外
// ... 解析 parts ...
if (parts.length === 0) return false;                        // 没内容
```

#### `ChatIRInboundEvent` 该带什么字段

```typescript
interface ChatIRInboundEvent {
  threadId: string;
  senderSid: string;
  message: ChatIRInboundMessage;       // 含 parts
  participantSids: string[];           // 当前线程的全部参与者 SID
}
```

**不要**塞 `isMentionAgent` / `isDm` 之类的"决策辅助"字段——这些 agent 自己从 `parts` 和 `participantSids` 算就行（见 `agent-integration-guide.md` §3.4）。保持 envelope 最小化让接口面更稳。

### 4.1 过滤回声

**问题**：你出站时刚把消息发到外部平台，**外部平台会通过 webhook / Gateway 把这条消息再推给你**。如果不过滤，agent 会看到自己的话再次入库。

**两层过滤**：

```typescript
if (msg.author.id === botUserId) return;          // 平台标识为 bot
if (mapper.isBotEcho(msg.id)) return;             // 自己刚发过的 message_id
```

**实现**：维护一个滚动窗口（默认最近 200 条），出站后 `rememberBotSent(messageId)`，入站时 `isBotEcho(messageId)` 查。

参考 `packages/discord-bridge/src/thread-mapper.ts`。

### 4.2 upsert 身份（直接进程内）

**没有 HTTP**——直接调注入的 `registry.upsert`：

```typescript
import type { IdentityRegistry, IdentityRecord } from '@utlra/chat-ir';

function upsertFeishuIdentity(
  registry: IdentityRegistry,
  user: FeishuUser,
  unionId?: string,
): string {
  const sid = `feishu:user:${user.ou_id}`;
  const prev = registry.get(sid);
  const rec: IdentityRecord = {
    schema: 'identity.v1',
    sid,
    kind: user.is_bot ? 'agent' : 'human',
    display_name: user.nickname ?? user.name ?? user.ou_id,
    aliases: prev?.aliases ?? [],
    roles_in_tenant: prev?.roles_in_tenant ?? (user.is_bot ? ['bot'] : ['member']),
    bindings: mergeBindings(prev?.bindings ?? [], {
      channel: 'feishu',
      native_user_id: user.ou_id,
      ...(unionId ? { native_union_id: unionId } : {}),
    }),
    updated_at: new Date().toISOString(),
  };
  registry.upsert(rec);
  return sid;
}
```

**对消息里被 @ 的用户也要 upsert**——否则 agent 拉 IdentityContextPack 时找不到这个 SID 的 display_name。

### 4.3 获取或创建 thread

每个外部渠道的"对话单元"（Discord channel / Slack channel / 飞书群）映射到一个 chat IR `thread_id`。

**映射存哪**：本地 JSON 文件，例如 `<DATA_ROOT>/<channel>/maps.json`（参考 `DiscordThreadMapper`）。

**首次见到一个外部 channel**：

```typescript
import { createThreadRecord } from '@utlra/chat-ir';

let threadId = mapper.getThreadId(externalChannelId);
if (!threadId) {
  const tr = createThreadRecord({
    tenant_id: 'default',
    channel: 'feishu',
    kind: isDm ? 'dm' : 'group',
    title: `飞书群: ${groupName}`,
    participant_sids: [agentSid, senderSid],
  });
  threadId = tr.thread_id;
  const store = loadThreads();
  store.threads.push(tr);
  store.messages[threadId] = [];
  saveThreads(store);
  mapper.bind(externalChannelId, threadId);
}
```

### 4.4 解析 parts

把外部协议的消息拆成 `MessagePart[]`。常见映射：

| 外部元素 | 翻译为 |
|---|---|
| 纯文本 | `{ type: 'text', text: '...' }` |
| @人提及 | `{ type: 'mention', target_sid: 'feishu:user:xxx', label: '张三' }` |
| 回复某条消息 | `{ type: 'quote', quoted_message_id: 'feishu:msg:xxx', excerpt: '...' }` |
| 图片附件 | `{ type: 'attachment', asset_ref: { kind: 'image', uri: 'asset:<id>', mime: '...', name: '...' } }` |
| 富卡片 / embed / 表情 | 优先映射；映射不出 → `{ type: 'unknown', channel: 'feishu', opaque: <原始 JSON> }` |

**关键约定**：

#### (a) mention 必须 SID 化

```typescript
{ type: 'mention', target_sid: 'feishu:user:ou_abc123', label: '张三' }
```

#### (b) bot 被 @ 用 agentSid

外部协议里 @ bot 通常是 `<@bot_user_id>`。**翻译时 target_sid 用 `agentSid`，不要用 bot 的渠道 native id**。

#### (c) text 里保留可读 @

```typescript
let cleanedText = msg.text;
for (const user of msg.mentions) {
  cleanedText = cleanedText.replace(new RegExp(`<@${user.id}>`, 'g'), `@${user.display_name}`);
}
parts.push({ type: 'text', text: cleanedText });
```

#### (d) 附件落到本地 `ChatAssetStore`

外部 CDN URL 通常有签名过期 / 私有访问限制，**入站时下载并存进注入的 `assetStore`**：

```typescript
const buf = Buffer.from(await fetch(externalAttachmentUrl).then(r => r.arrayBuffer()));
const saved = assetStore.save(buf, mime, name);
parts.push({
  type: 'attachment',
  asset_ref: {
    kind: inferKind(mime),
    uri: `asset:${saved.id}`,          // ← agent 侧统一约定
    mime: saved.mime,
    name: saved.name,
  },
});
```

`asset:<uuid>` 是 chat IR 约定的本地 asset URI scheme。出站渲染时通过 `assetStore.get(id)` 取回原始 buffer 重新上传到目标平台。

### 4.5 写 MessageRecord + 触发 callback

注意：`threadRecord` 是 §4.3 里 get-or-create 得到的（含 `participant_sids`）。

**时间字段必须是 ISO 8601 with offset**——`MessageRecord.sent_at` schema 已强制 `z.string().datetime({ offset: true })`，写错会立刻 `MessageRecordSchema.parse(...)` 抛出。把外部平台的 epoch 时间戳 / RFC 3339 字符串转成标准 ISO：

```typescript
sent_at: new Date(epochMillis).toISOString(),                  // ✅ 数字 → ISO
sent_at: new Date(externalIsoString).toISOString(),            // ✅ 重新规范化（兼容无毫秒位）
// ❌ sent_at: externalIsoString                                 直接透传可能格式不符
// ❌ sent_at: '2024-01-01 12:00:00'                             缺 offset
// ❌ sent_at: new Date().toString()                             非 ISO
```

详细规则见 [`chat-ir-identity-design.md §3.5`](./chat-ir-identity-design.md#35-时间字段约定强制-iso-8601-with-offset)。

```typescript
const messageRecord: MessageRecord = MessageRecordSchema.parse({
  schema: 'message.v1',
  message_id: `feishu:${msg.message_id}`,  // 用外部 id 做稳定前缀（方便反查）
  thread_id: threadId,
  sender_sid: senderSid,
  sent_at: new Date(msg.create_time).toISOString(),
  parts,
});

const store = loadThreads();
if (!store.messages[threadId]) store.messages[threadId] = [];
store.messages[threadId]!.push(messageRecord);
saveThreads(store);

// 必须！喂给共享 tracker（含 mention_target_sids，供 freshCheck 区分「分别@」与「多人@抢答」）
this.opts.seenTracker.track(threadId, {
  message_id: messageRecord.message_id,
  sender_sid: senderSid,
  mention_target_sids: mentionTargetSidsFromParts(parts),
});

// 自己发的不回环触发（§4.0 已规定 sender = bot 在最顶层就过滤了；这里是兜底）
if (senderSid === this.opts.agentSid) return;

// 触发 agent 业务代码——不预先判断"该不该回"，让 agent 自己做（见 §4.0）
await this.opts.onAgentMessage({
  threadId,
  senderSid,
  message: messageRecord,
  participantSids: threadRecord.participant_sids,
});
```

---

## 5. 出站方向（chat IR → 外部）

`postMessage(threadId, body)` 是 agent 业务代码唯一的出站入口。

### 5.1 解析 body 到 parts

```typescript
function resolveParts(body: ChatIROutboundBody, registry: IdentityRegistry): MessagePart[] {
  if (Array.isArray(body.parts) && body.parts.length > 0) return body.parts as MessagePart[];
  const text = body.text?.trim();
  if (!text) return [];
  if (body.parse_mentions === false) return [{ type: 'text', text }];
  return plainTextToPartsWithMentions(text, registry);
}
```

### 5.2 渲染到外部 wire

每个渠道写一份 `renderForFeishu(parts) → FeishuMessagePayload`，规则：

- `mention { target_sid }` → 反查渠道 native id → `<at user_id="...">` 等
- `text` → 文本
- `attachment.asset_ref.uri = "asset:<id>"` → `assetStore.get(id)` → multipart 上传到目标平台
- `attachment.asset_ref.uri = "http(s)://..."` → 直接当外链（让目标平台自己抓预览）
- `unknown` → 忽略或降级文本

#### 处理 `asset:<id>` 的范例

```typescript
import type { ChatAssetStore, MessagePart } from '@utlra/chat-ir';

function renderAttachment(
  part: Extract<MessagePart, { type: 'attachment' }>,
  assetStore: ChatAssetStore,
): { kind: 'local'; buffer: Buffer; mime: string; name: string } | { kind: 'remote'; url: string } | null {
  const { uri, mime, name } = part.asset_ref;
  if (uri.startsWith('asset:')) {
    const id = uri.slice('asset:'.length);
    const got = assetStore.get(id);
    if (!got) return null;                                              // 本地丢失，降级为文本
    return { kind: 'local', buffer: got.buffer, mime: got.meta.mime, name: got.meta.name };
  }
  if (uri.startsWith('http://') || uri.startsWith('https://')) {
    return { kind: 'remote', url: uri };
  }
  return null;
}
```

`local` 走目标平台的 multipart 上传 API；`remote` 直接放进文本或对应外链字段。

参考 `packages/discord-bridge/src/reply-render.ts`。

### 5.3 调外部 REST + 写 store + 防回声

```typescript
const sentId = await feishuClient.sendMessage(externalChannelId, payload);
if (!sentId) return;

mapper.rememberBotSent(sentId);

const rec = MessageRecordSchema.parse({
  schema: 'message.v1',
  message_id: `feishu:${sentId}`,
  thread_id: threadId,
  sender_sid: body.sender_sid,
  sent_at: new Date().toISOString(),
  parts,
});
const store = loadThreads();
if (!store.messages[threadId]) store.messages[threadId] = [];
store.messages[threadId]!.push(rec);
saveThreads(store);

// 同样：必须喂给 tracker，否则发完自己的消息不计入连续 agent 链 / 新鲜度
this.opts.seenTracker.track(threadId, {
  message_id: rec.message_id,
  sender_sid: rec.sender_sid,
});
```

### 5.4 活动信号（`sendActivity`，可选）

`sendActivity(threadId, 'typing' | 'idle')` 是**可选扩展方法**（不在 `ChatIRChannel` 必选 3 方法内）：
瞬时、不落库、best-effort——失败只记日志，绝不影响主流程。

| 渠道 | 实现方式 |
|---|---|
| WebChat | REST `typing.relay`（原生 typing 指示） |
| Discord | Gateway typing 事件（原生） |
| **飞书** | **无 typing API → 用消息表情回复（reaction）模拟**（决策于 2026-07-15，沿用 OpenClaw 方案） |

**飞书 reaction 模拟约定**：

- 入站处理器记录每个 thread 最后一条人类消息的飞书 native `message_id`
- `typing` → `POST /im/v1/messages/:message_id/reactions`，body `{"reaction_type": {"emoji_type": "Typing"}}`（官方就有 `Typing` 打字中表情；备选 `OnIt` / `OneSecond`），把返回 `reaction_id` 存 `Map<threadId, { messageId, reactionId }>`
- `idle` → `DELETE /im/v1/messages/:message_id/reactions/:reaction_id`；`postMessage` 成功后也顺手撤（回复已发出 = 不再"打字"）
- 权限：`im:message.reactions:write_only`（或 `im:message`）；频控 1000 次/分钟
- 边界都按 best-effort 处理：消息被撤回（230110）、重启丢 `reaction_id`、重复 typing（Map 去重幂等）→ 只记日志

---

## 6. 在 agent 入口注入桥

`packages/server/src/index.ts` 是 **唯一** 知道并 `new` 具体 `ChatIRChannel` 实现的地方：

```typescript
// 1) 先建 tracker（进程内单例）
const seenTracker = new ChatIRSeenTracker({
  selfAgentSid: agentSid,
  identityRegistry: registry,
});

// 2) 再建 channel，把 tracker 注入
let channel: ChatIRChannel;
const feishuCfg = loadFeishuConfig();
if (feishuCfg) {
  channel = new FeishuChannel({
    config: feishuCfg,
    agentSid,
    dataRoot: DATA_ROOT,
    registry,
    assetStore,
    loadThreads,
    saveThreads,
    seenTracker,
    onAgentMessage,
  });
} else {
  channel = new NullChatIRChannel();
}

// 3) OuterBrain 也注入同一个 tracker
outerBrain = new OuterBrain({ imClient: channel, seenTracker, /* ... */ });
channel.start();
```

**多渠道并行 / 飞书多连接**（已落地 2026-07-16）：进程唯一 imClient = `FanInChatIRChannel`（`@utlra/chat-ir/runtime`）；主渠道是它的 default 连接，`ChannelConnectionRegistry`（`packages/server/src/outer/channel-connection-registry.ts`）负责运行时热插更多连接（keychain secret_ref、探测失败回滚、bootLoad 重连）。新桥要接入多连接：实现 `ChannelConnector.connect(record, secret)` 返回 `{ channel, botNativeId }`，在 `index.ts` 的 `connectors` map 注册。入站回调用 `fanIn.makeInboundHandler(connectionId)`，出站自动按 thread→connection 路由（未知 thread 落 default）。权威设计：[`structurizr/IDENTITY-CROSS-CHANNEL.md`](./structurizr/IDENTITY-CROSS-CHANNEL.md) §5。

**参考实现：`@utlra/feishu-bridge`**（2026-07-17 落地，`packages/feishu-bridge`）——上述全套约定的第一个完整范例：`createFeishuConnector`（探测 token+bot info、失败抛异常触发回滚）、thread_id 编入 app_id（`feishu:<app_id>:chat:<chat_id>`，多连接出站归属天然成立）、入站 `channel_key = {feishu, union_id∥open_id, scope=app_id}` 经 `resolveInboundSenderSid`、Typing = reaction 模拟（§5.4）、事件源接口 `FeishuEventSource` 可注入（生产 = 飞书长连接 SDK 可选依赖）。写新桥先抄它。

**跨渠道同人**：入站 `sender_sid` 必须经 `identityBindingIndex.resolve`；同人绑定仅 `identityLinkService` 双边确认（或 admin），**不**由桥或 LLM 猜测。

---

## 7. 测试建议

1. **单元**：mention 解析 / asset 上传 / SID 编码 — 覆盖 §4.4 / §5.2
2. **集成**：起一个 fake 外部服务器（如本地 webhook 路由 mock），跑 inbound + agent 回复 + outbound 全路径
3. **回声防护**：手动让 outbound 把自己刚发的消息 echo 回来，验证被丢弃
4. **附件过期**：模拟 CDN 返回 404，验证降级渲染（外链或 `[附件: ...]` 文本占位）

---

## 8. 参考实现速查（Discord 桥）

| 主题 | 文件 |
|---|---|
| ChatIRChannel 入口 | `packages/discord-bridge/src/discord-channel.ts` |
| 入站翻译 | `packages/discord-bridge/src/inbound.ts` |
| 出站渲染 | `packages/discord-bridge/src/reply-render.ts` |
| 身份映射 + upsert | `packages/discord-bridge/src/identity-mapper.ts` |
| thread ↔ channel 映射 + 回声防护 | `packages/discord-bridge/src/thread-mapper.ts` |
| 附件下载到本地 ChatAssetStore | `packages/discord-bridge/src/attachment.ts` |
| Discord Gateway 客户端 | `packages/discord-bridge/src/client.ts` |
| 配置加载 | `packages/discord-bridge/src/config.ts` |

照着这一套结构写新渠道桥，大约 500-800 行代码。

---

## 修订记录

| 日期 | 说明 |
|------|------|
| 2026-05-12 | v2 删 IM Server：adapter 直接 implements `ChatIRChannel`，进程内调用 store/registry/asset |
| 2026-05-13 | v2.1 §4.0 入站过滤合同表（adapter 该过滤什么 / 不该过滤什么）+ §5.2 加 `asset:<id>` 渲染范例；修 §4.5 `threadRecord` 上下文歧义 |
| 2026-05-14 | v2.2 抽 `ChatIRSeenTracker`：桥不再自己实现 `countConsecutive*` / `hasAnother*`，只需在入站落库后 + 出站发送后各调一次 `seenTracker.track(...)`。channel 接口缩到 3 方法 |
| 2026-07-15 | v2.3 新增 §5.4 活动信号：`sendActivity` 各渠道实现对照；确定飞书桥用 reaction（`emoji_type: "Typing"`）模拟打字指示 |
| 2026-07-16 | v2.4 §6：多连接/飞书热插与跨渠道 resolve 改以 [`structurizr/IDENTITY-CROSS-CHANNEL.md`](./structurizr/IDENTITY-CROSS-CHANNEL.md) 为权威 |
| 2026-07-17 | v2.5 §6：`@utlra/feishu-bridge` 落地，作为多连接桥参考实现 |

/**
 * Discord MESSAGE_CREATE → chat IR 入站处理。
 *
 * 流程（无中间 IM Server，全部进程内）：
 *   1) 过滤回声：bot 自己发的（author.bot && author.id === botUserId）+ 出站记录命中
 *   2) 解析 channel：DM / Guild Text / Guild Thread → 决定 thread_kind 与显示信息
 *   3) 获取或创建对应 chat IR thread（首次出现的频道新建 ThreadRecord + 写 store）
 *   4) 把 Discord User upsert 到 IdentityRegistry（discord:user:<id>）
 *   5) 解析 mentions / attachments / reply_reference 为 MessagePart[]
 *   6) 把 MessageRecord 写入 store
 *   7) 触发 `onAgentMessage` callback（递给 agent 业务代码）
 */
import { randomUUID } from 'node:crypto';
import type { Message, OmitPartialGroupDMChannel } from 'discord.js';
import { ChannelType } from 'discord.js';
import {
  MessageRecordSchema,
  createThreadRecord,
  ThreadRecordSchema,
  resolveInboundSenderSid,
  type ChatAssetStore,
  type ChatIRInboundEvent,
  type ChatIRInboundMessage,
  type IdentityBindingIndex,
  type IdentityRegistry,
  type LooseThreadStore,
  type MessageRecord,
  type ThreadRecord,
} from '@utlra/chat-ir';
import type { DiscordBridgeConfig } from './config.js';
import {
  discordUserToSid,
  discordUserDisplayName,
  upsertDiscordIdentity,
  type DiscordUserShape,
} from './identity-mapper.js';
import { DiscordThreadMapper } from './thread-mapper.js';
import {
  attachmentKindFromMime,
  downloadDiscordAttachment,
  type DiscordAttachmentShape,
} from './attachment.js';

export interface InboundDeps {
  config: DiscordBridgeConfig;
  mapper: DiscordThreadMapper;
  agentSid: string;
  botUserId: string;
  registry: IdentityRegistry;
  bindingIndex?: IdentityBindingIndex | null;
  assetStore: ChatAssetStore;
  loadThreads: () => LooseThreadStore;
  saveThreads: (data: LooseThreadStore) => void;
  /** 消息已落库后触发，让 channel 做 trackSeen 并通知 agent */
  onMessagePersisted: (ev: {
    threadId: string;
    senderSid: string;
    message: ChatIRInboundMessage;
    participantSids: string[];
  }) => Promise<void>;
  fetchImpl?: typeof fetch;
}

interface MessagePart {
  type: 'text' | 'mention' | 'quote' | 'attachment' | 'unknown';
  [k: string]: unknown;
}

/**
 * 处理一条 Discord 消息：负责所有过滤 / 映射 / 落库到 chat IR。
 * 返回 true = 已落库并通知 agent，false = 被过滤或失败（已打日志）。
 */
export async function handleDiscordMessage(
  deps: InboundDeps,
  msg: OmitPartialGroupDMChannel<Message<boolean>>,
): Promise<boolean> {
  const fetchFn = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);

  if (msg.author.id === deps.botUserId) return false;
  if (deps.mapper.isBotEcho(msg.id)) return false;

  const guildId = msg.guildId ?? undefined;
  if (guildId && deps.config.guildAllowlist.length > 0) {
    if (!deps.config.guildAllowlist.includes(guildId)) {
      return false;
    }
  }

  const channelId = msg.channelId;
  const channelType = msg.channel.type;
  const isDm = channelType === ChannelType.DM;
  const threadKind: 'dm' | 'group' = isDm ? 'dm' : 'group';

  const senderShape = toUserShape(msg);
  const provisionalSid = upsertDiscordIdentity(deps.registry, senderShape, guildId);
  const senderSid = resolveInboundSenderSid(
    deps.bindingIndex,
    { channel: 'discord', native_user_id: senderShape.id },
    provisionalSid,
  );

  for (const u of msg.mentions.users.values()) {
    if (u.id === deps.botUserId) continue;
    const mentionProv = upsertDiscordIdentity(
      deps.registry,
      {
        id: u.id,
        username: u.username,
        globalName: u.globalName,
        bot: u.bot,
      },
      guildId,
    );
    resolveInboundSenderSid(
      deps.bindingIndex,
      { channel: 'discord', native_user_id: u.id },
      mentionProv,
    );
  }

  let imThreadId = deps.mapper.getThreadId(channelId);
  let threadRecord: ThreadRecord | undefined;
  const store = deps.loadThreads();
  if (!imThreadId) {
    const title = isDm
      ? `Discord DM: ${discordUserDisplayName(senderShape)}`
      : `Discord ${guildId ? 'Guild' : 'Thread'}: ${
          'name' in msg.channel && typeof msg.channel.name === 'string' ? msg.channel.name : channelId
        }`;
    threadRecord = createThreadRecord({
      tenant_id: deps.config.tenant,
      channel: 'discord',
      kind: threadKind,
      title,
      participant_sids: [deps.agentSid, senderSid],
    });
    imThreadId = threadRecord.thread_id;
    store.threads.push(threadRecord);
    store.messages[imThreadId] = [];
    deps.mapper.bind(channelId, imThreadId);
    console.log(
      `[discord-bridge] thread bound: discord ${channelId} ↔ chat-ir ${imThreadId} (${threadKind})`,
    );
  } else {
    threadRecord = findThreadInStore(store, imThreadId);
    if (threadRecord && !threadRecord.participant_sids.includes(senderSid)) {
      threadRecord = {
        ...threadRecord,
        participant_sids: [...threadRecord.participant_sids, senderSid],
      };
      replaceThreadInStore(store, threadRecord);
    }
  }

  const parts: MessagePart[] = [];

  let isMentionAgent = false;
  if (msg.mentions.users.has(deps.botUserId)) {
    isMentionAgent = true;
    parts.push({
      type: 'mention',
      target_sid: deps.agentSid,
      label: '助手',
    });
  }
  for (const u of msg.mentions.users.values()) {
    if (u.id === deps.botUserId) continue;
    parts.push({
      type: 'mention',
      target_sid: discordUserToSid({
        id: u.id,
        username: u.username,
        globalName: u.globalName,
        bot: u.bot,
      }),
      label: u.globalName ?? u.username,
    });
  }

  const replyRef = msg.reference?.messageId;
  if (replyRef) {
    parts.push({
      type: 'quote',
      quoted_message_id: `discord:${replyRef}`,
    });
  }

  let cleanedContent = msg.content ?? '';
  if (isMentionAgent) {
    const mentionRe = new RegExp(`<@!?${deps.botUserId}>`, 'g');
    cleanedContent = cleanedContent.replace(mentionRe, `@助手`);
  }
  for (const u of msg.mentions.users.values()) {
    if (u.id === deps.botUserId) continue;
    const re = new RegExp(`<@!?${u.id}>`, 'g');
    cleanedContent = cleanedContent.replace(re, `@${u.globalName ?? u.username}`);
  }
  if (cleanedContent.trim()) {
    parts.push({ type: 'text', text: cleanedContent });
  }

  if (msg.attachments.size > 0) {
    const dlTasks: Promise<DiscordAttachmentShape & {
      _uri: string;
      _mime: string;
      _name: string;
      _size?: number;
    }>[] = [];
    for (const att of msg.attachments.values()) {
      const shape: DiscordAttachmentShape = {
        id: att.id,
        url: att.url,
        proxyUrl: att.proxyURL,
        name: att.name ?? undefined,
        contentType: att.contentType,
        size: att.size,
      };
      if (deps.config.downloadAttachments) {
        dlTasks.push(
          downloadDiscordAttachment(deps.assetStore, shape, fetchFn).then((r) => ({
            ...shape,
            _uri: r.uri,
            _mime: r.mime,
            _name: r.name,
            _size: r.size,
          })),
        );
      } else {
        dlTasks.push(
          Promise.resolve({
            ...shape,
            _uri: shape.url,
            _mime: shape.contentType ?? 'application/octet-stream',
            _name: shape.name ?? `discord-${shape.id}`,
            _size: shape.size,
          }),
        );
      }
    }
    const results = await Promise.all(dlTasks);
    for (const r of results) {
      parts.push({
        type: 'attachment',
        asset_ref: {
          kind: attachmentKindFromMime(r._mime),
          uri: r._uri,
          mime: r._mime,
          name: r._name,
        },
      });
    }
  }

  if (msg.embeds.length > 0) {
    for (const e of msg.embeds) {
      const summary = [e.title, e.description, e.url].filter(Boolean).join('\n');
      if (summary) {
        parts.push({ type: 'text', text: `[embed]\n${summary}` });
      }
      parts.push({
        type: 'unknown',
        channel: 'discord',
        opaque: e.toJSON ? e.toJSON() : { title: e.title, description: e.description },
      });
    }
  }

  if (parts.length === 0) {
    return false;
  }

  const messageRecord: MessageRecord = MessageRecordSchema.parse({
    schema: 'message.v1',
    message_id: `discord:${msg.id}`,
    thread_id: imThreadId,
    sender_sid: senderSid,
    sent_at: new Date(msg.createdTimestamp).toISOString(),
    parts,
  });

  if (!store.messages[imThreadId]) store.messages[imThreadId] = [];
  store.messages[imThreadId]!.push(messageRecord);
  deps.saveThreads(store);

  const participantSids = threadRecord?.participant_sids ?? [deps.agentSid, senderSid];

  console.log(
    `[discord-bridge] ← discord ${msg.author.username}#${msg.id} → chat-ir ${imThreadId} parts=${parts.length}`,
  );

  try {
    await deps.onMessagePersisted({
      threadId: imThreadId,
      senderSid,
      message: messageRecord,
      participantSids,
    });
  } catch (e) {
    console.error('[discord-bridge] onMessagePersisted error', e);
  }
  return true;
}

function toUserShape(
  msg: OmitPartialGroupDMChannel<Message<boolean>>,
): DiscordUserShape {
  return {
    id: msg.author.id,
    username: msg.author.username,
    globalName: msg.author.globalName,
    bot: msg.author.bot,
    guildNickname: msg.member?.nickname ?? null,
  };
}

function findThreadInStore(store: LooseThreadStore, threadId: string): ThreadRecord | undefined {
  for (const t of store.threads) {
    const p = ThreadRecordSchema.safeParse(t);
    if (p.success && p.data.thread_id === threadId) return p.data;
  }
  return undefined;
}

function replaceThreadInStore(store: LooseThreadStore, tr: ThreadRecord): void {
  for (let i = 0; i < store.threads.length; i++) {
    const p = ThreadRecordSchema.safeParse(store.threads[i]);
    if (p.success && p.data.thread_id === tr.thread_id) {
      store.threads[i] = tr;
      return;
    }
  }
  store.threads.push(tr);
}

/**
 * 入站翻译：飞书 `im.message.receive_v1` 事件 → chat IR `MessageRecord`。
 *
 * 流程（与 webchat-bridge/inbound.ts 同构）：
 * 1. 事件去重（event_id / message_id）
 * 2. 过滤 bot 自己的回声（sender open_id == botOpenId）
 * 3. upsertFeishuIdentity + resolveInboundSenderSid（channel_key 带 scope=app_id）
 * 4. content 解析：text 的 `@_user_N` 占位替换为 mention part；@bot → agentSid
 * 5. ensureThread（p2p → dm；group → group）+ 落库 + onMessagePersisted
 * 6. 记录 thread 最后一条人类消息的飞书 native message_id（Typing reaction 用）
 */
import {
  MessageRecordSchema,
  ThreadRecordSchema,
  createThreadRecord,
  resolveInboundSenderSid,
  type ChatIRInboundMessage,
  type IdentityBindingIndex,
  type IdentityRegistry,
  type LooseThreadStore,
  type MessagePart,
  type MessageRecord,
  type ThreadRecord,
} from '@utlra/chat-ir';
import {
  feishuChannelKey,
  upsertFeishuIdentity,
  type FeishuSenderIds,
} from './identity-mapper.js';
import { feishuChatToIr, feishuMessageIdToIr } from './thread-mapper.js';

/** `im.message.receive_v1` 事件里桥需要的最小面（SDK/webhook payload 的子集） */
export interface FeishuInboundEvent {
  event_id?: string;
  sender: {
    sender_id?: FeishuSenderIds;
    sender_type?: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    /** p2p = 单聊；group = 群聊 */
    chat_type: 'p2p' | 'group' | string;
    message_type: string;
    /** JSON 字符串，形状随 message_type 变化 */
    content: string;
    /** 回复消息时的父消息 id */
    parent_id?: string;
    create_time?: string;
    mentions?: Array<{
      key: string;
      id?: FeishuSenderIds;
      name?: string;
    }>;
  };
}

export interface FeishuInboundDeps {
  appId: string;
  tenant: string;
  agentSid: string;
  /** 本连接 bot 的 open_id（探测时得到）；用于回声过滤与 @bot 翻译 */
  botOpenId: string;
  registry: IdentityRegistry;
  bindingIndex?: IdentityBindingIndex | null;
  loadThreads: () => LooseThreadStore;
  saveThreads: (data: LooseThreadStore) => void;
  /** 已处理事件去重集合（channel 持有，跨事件复用） */
  seenEventIds: Set<string>;
  /** thread → 最后一条人类消息的飞书 native message_id（Typing reaction 用） */
  lastHumanMessageId: Map<string, string>;
  onMessagePersisted: (ev: {
    threadId: string;
    senderSid: string;
    message: ChatIRInboundMessage;
    participantSids: string[];
  }) => Promise<void>;
}

const SEEN_CAP = 2000;

function resolveFeishuSender(
  deps: FeishuInboundDeps,
  ids: FeishuSenderIds,
  displayName: string,
): string | null {
  const key = feishuChannelKey(deps.appId, ids);
  if (!key) return null;
  const provisional = upsertFeishuIdentity(deps.registry, ids, displayName, deps.tenant);
  return resolveInboundSenderSid(deps.bindingIndex, key, provisional);
}

/** text content：`{"text":"@_user_1 你好"}` → parts（mention 占位替换） */
function parseTextParts(
  deps: FeishuInboundDeps,
  raw: string,
  mentions: NonNullable<FeishuInboundEvent['message']['mentions']>,
): MessagePart[] {
  const parts: MessagePart[] = [];
  const byKey = new Map(mentions.map((m) => [m.key, m]));
  // 按占位符切分；占位符形如 @_user_1
  const segments = raw.split(/(@_user_\d+)/g);
  for (const seg of segments) {
    if (!seg) continue;
    const mention = byKey.get(seg);
    if (!mention) {
      parts.push({ type: 'text', text: seg });
      continue;
    }
    const label = mention.name ?? seg;
    if (mention.id?.open_id === deps.botOpenId) {
      // @bot 自己 → agent IR sid（与 webchat/discord 行为一致）
      parts.push({ type: 'mention', target_sid: deps.agentSid, label });
      continue;
    }
    const sid = mention.id ? resolveFeishuSender(deps, mention.id, label) : null;
    if (sid) parts.push({ type: 'mention', target_sid: sid, label });
    else parts.push({ type: 'text', text: label });
  }
  return parts;
}

function extractParts(deps: FeishuInboundDeps, ev: FeishuInboundEvent): MessagePart[] {
  const { message } = ev;
  let content: Record<string, unknown> = {};
  try {
    content = JSON.parse(message.content) as Record<string, unknown>;
  } catch {
    return [{ type: 'text', text: message.content }];
  }
  if (message.message_type === 'text' && typeof content['text'] === 'string') {
    return parseTextParts(deps, content['text'], message.mentions ?? []);
  }
  // post（富文本）：抽取纯文本行
  if (message.message_type === 'post') {
    const text = extractPostText(content);
    if (text) return [{ type: 'text', text }];
  }
  // 其它类型（image/file/audio/sticker…）P2b 先降级为占位文本，资源镜像后续补
  return [
    { type: 'text', text: `[飞书 ${message.message_type} 消息，暂未镜像内容]` },
  ];
}

function extractPostText(content: Record<string, unknown>): string {
  const chunks: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node && typeof node === 'object') {
      const o = node as Record<string, unknown>;
      if (typeof o['text'] === 'string') chunks.push(o['text']);
      for (const v of Object.values(o)) {
        if (typeof v === 'object') walk(v);
      }
    }
  };
  walk(content);
  return chunks.join(' ').trim();
}

export async function handleFeishuInbound(
  deps: FeishuInboundDeps,
  ev: FeishuInboundEvent,
): Promise<boolean> {
  const dedupeKey = ev.event_id ?? ev.message.message_id;
  if (deps.seenEventIds.has(dedupeKey)) return false;
  deps.seenEventIds.add(dedupeKey);
  if (deps.seenEventIds.size > SEEN_CAP) {
    // 简单裁剪：删最早的一批（Set 按插入序迭代）
    for (const k of deps.seenEventIds) {
      deps.seenEventIds.delete(k);
      if (deps.seenEventIds.size <= SEEN_CAP / 2) break;
    }
  }

  const senderIds = ev.sender.sender_id ?? {};
  if (senderIds.open_id && senderIds.open_id === deps.botOpenId) return false;

  const senderSid = resolveFeishuSender(deps, senderIds, senderIds.user_id ?? '');
  if (!senderSid) return false; // 系统消息等无 sender id

  const irThreadId = feishuChatToIr(deps.appId, ev.message.chat_id);
  const store = deps.loadThreads();
  let threadRecord = findThreadInStore(store, irThreadId);
  if (!threadRecord) {
    threadRecord = createThreadRecord({
      thread_id: irThreadId,
      tenant_id: deps.tenant,
      channel: 'feishu',
      kind: ev.message.chat_type === 'p2p' ? 'dm' : 'group',
      participant_sids: dedupe([senderSid, deps.agentSid]),
    });
    store.threads.push(threadRecord);
    if (!store.messages[irThreadId]) store.messages[irThreadId] = [];
  } else {
    let ps = threadRecord.participant_sids;
    let changed = false;
    if (!ps.includes(senderSid)) {
      ps = [...ps, senderSid];
      changed = true;
    }
    if (!ps.includes(deps.agentSid)) {
      ps = [...ps, deps.agentSid];
      changed = true;
    }
    if (changed) {
      threadRecord = { ...threadRecord, participant_sids: dedupe(ps) };
      replaceThreadInStore(store, threadRecord);
    }
  }

  const parts = extractParts(deps, ev);
  if (parts.length === 0) return false;

  const sentAt = ev.message.create_time
    ? new Date(Number(ev.message.create_time)).toISOString()
    : new Date().toISOString();

  const messageRecord: MessageRecord = MessageRecordSchema.parse({
    schema: 'message.v1',
    message_id: feishuMessageIdToIr(deps.appId, ev.message.message_id),
    thread_id: irThreadId,
    sender_sid: senderSid,
    sent_at: sentAt,
    ...(ev.message.parent_id
      ? { reply_to_message_id: feishuMessageIdToIr(deps.appId, ev.message.parent_id) }
      : {}),
    parts,
  });

  if (!store.messages[irThreadId]) store.messages[irThreadId] = [];
  store.messages[irThreadId]!.push(messageRecord);
  deps.saveThreads(store);

  // Typing reaction 目标：这条人类消息
  deps.lastHumanMessageId.set(irThreadId, ev.message.message_id);

  try {
    await deps.onMessagePersisted({
      threadId: irThreadId,
      senderSid,
      message: messageRecord,
      participantSids: threadRecord.participant_sids,
    });
  } catch (e) {
    console.error('[feishu-bridge] onMessagePersisted error', e);
  }
  return true;
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

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

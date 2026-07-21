/**
 * 入站翻译：iLink `getupdates` 的 WeixinMessage → chat IR `MessageRecord`。
 *
 * 流程（与 feishu-bridge/inbound.ts 同构）：
 * 1. 只收 `message_type=1`（用户消息；2=bot 回声跳过）
 * 2. 去重（message_id / client_id）
 * 3. upsertWechatIdentity + resolveInboundSenderSid（channel_key 带 scope=bot_id）
 * 4. item_list → parts（text；媒体先降级占位文本）
 * 5. ensureThread（基本仅 dm；group_id 存在则 group）+ 落库 + onMessagePersisted
 * 6. **缓存 context_token**（thread → 最近入站锚点；出站 sendmessage 必须回传）
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
import type { WeixinMessage } from './ilink-api-client.js';
import { upsertWechatIdentity, wechatChannelKey } from './identity-mapper.js';
import { wechatDmToIr, wechatGroupToIr, wechatMessageIdToIr } from './thread-mapper.js';

export interface WechatInboundDeps {
  botId: string;
  tenant: string;
  agentSid: string;
  registry: IdentityRegistry;
  bindingIndex?: IdentityBindingIndex | null;
  loadThreads: () => LooseThreadStore;
  saveThreads: (data: LooseThreadStore) => void;
  /** 已处理消息去重集合（channel 持有） */
  seenMessageIds: Set<string>;
  /** thread → 最近入站 context_token（出站回传锚点；channel 持有） */
  contextTokens: Map<string, string>;
  onMessagePersisted: (ev: {
    threadId: string;
    senderSid: string;
    message: ChatIRInboundMessage;
    participantSids: string[];
  }) => Promise<void>;
}

const SEEN_CAP = 2000;

const MEDIA_LABEL: Record<number, string> = {
  2: '图片',
  3: '语音',
  4: '文件',
  5: '视频',
};

function extractParts(msg: WeixinMessage): MessagePart[] {
  const parts: MessagePart[] = [];
  for (const item of msg.item_list ?? []) {
    if (item.type === 1 && typeof item.text_item?.text === 'string') {
      if (item.text_item.text) parts.push({ type: 'text', text: item.text_item.text });
      continue;
    }
    const label = MEDIA_LABEL[item.type ?? 0];
    if (label) parts.push({ type: 'text', text: `[微信${label}消息，暂未镜像内容]` });
  }
  return parts;
}

export async function handleWechatInbound(
  deps: WechatInboundDeps,
  msg: WeixinMessage,
): Promise<boolean> {
  // 只处理用户消息；bot 出站消息也会出现在 getupdates 里（回声）
  if (msg.message_type !== 1) return false;
  const fromUserId = msg.from_user_id ?? '';
  if (!fromUserId || fromUserId === deps.botId) return false;

  const dedupeKey = String(msg.message_id ?? msg.client_id ?? '');
  if (!dedupeKey) return false;
  if (deps.seenMessageIds.has(dedupeKey)) return false;
  deps.seenMessageIds.add(dedupeKey);
  if (deps.seenMessageIds.size > SEEN_CAP) {
    for (const k of deps.seenMessageIds) {
      deps.seenMessageIds.delete(k);
      if (deps.seenMessageIds.size <= SEEN_CAP / 2) break;
    }
  }

  const key = wechatChannelKey(deps.botId, fromUserId);
  if (!key) return false;
  const provisional = upsertWechatIdentity(deps.registry, fromUserId, '', deps.tenant);
  const senderSid = resolveInboundSenderSid(deps.bindingIndex, key, provisional);

  const irThreadId = msg.group_id
    ? wechatGroupToIr(deps.botId, msg.group_id)
    : wechatDmToIr(deps.botId, fromUserId);

  const store = deps.loadThreads();
  let threadRecord = findThreadInStore(store, irThreadId);
  if (!threadRecord) {
    threadRecord = createThreadRecord({
      thread_id: irThreadId,
      tenant_id: deps.tenant,
      channel: 'wechat',
      kind: msg.group_id ? 'group' : 'dm',
      participant_sids: dedupe([senderSid, deps.agentSid]),
    });
    store.threads.push(threadRecord);
    if (!store.messages[irThreadId]) store.messages[irThreadId] = [];
  } else {
    let ps = threadRecord.participant_sids;
    let changed = false;
    for (const sid of [senderSid, deps.agentSid]) {
      if (!ps.includes(sid)) {
        ps = [...ps, sid];
        changed = true;
      }
    }
    if (changed) {
      threadRecord = { ...threadRecord, participant_sids: dedupe(ps) };
      replaceThreadInStore(store, threadRecord);
    }
  }

  const parts = extractParts(msg);
  if (parts.length === 0) return false;

  const sentAt = msg.create_time_ms
    ? new Date(msg.create_time_ms).toISOString()
    : new Date().toISOString();

  const messageRecord: MessageRecord = MessageRecordSchema.parse({
    schema: 'message.v1',
    message_id: wechatMessageIdToIr(deps.botId, msg.message_id ?? dedupeKey),
    thread_id: irThreadId,
    sender_sid: senderSid,
    sent_at: sentAt,
    parts,
  });

  if (!store.messages[irThreadId]) store.messages[irThreadId] = [];
  store.messages[irThreadId]!.push(messageRecord);
  deps.saveThreads(store);

  // 会话锚点：出站回复必须回传最近一次入站的 context_token
  if (msg.context_token) deps.contextTokens.set(irThreadId, msg.context_token);

  try {
    await deps.onMessagePersisted({
      threadId: irThreadId,
      senderSid,
      message: messageRecord,
      participantSids: threadRecord.participant_sids,
    });
  } catch (e) {
    console.error('[wechat-bridge] onMessagePersisted error', e);
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

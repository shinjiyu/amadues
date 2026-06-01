/**
 * 入站翻译：chat-server `Message` → chat IR `MessageRecord`。
 *
 * 流程：
 * 1. 过滤回声：发送者是 agent 自己 → 直接 return
 * 2. upsertWebChatIdentity → 拿到发送者 sid
 * 3. ensureThread：如果 IR threads 里没有这条 thread，自动 createThreadRecord 写入
 * 4. parts: text / mention / attachment 翻译；reply_to → MessageRecord.reply_to_message_id
 * 5. attachment.kind 推断（image/video/audio/file），uri 取 chat-server 绝对 URL；
 *    若 mirrorAssets=1，下载 → assetStore.save() → uri 改为 `asset:<uuid>`
 * 6. 写入 store + 调 onMessagePersisted
 */
import {
  MessageRecordSchema,
  ThreadRecordSchema,
  createThreadRecord,
  type ChatAssetStore,
  type ChatIRInboundMessage,
  type IdentityRegistry,
  type LooseThreadStore,
  type MessagePart,
  type MessageRecord,
  type ThreadRecord,
} from '@utlra/chat-ir';
import {
  type Message as WebChatMessage,
  type Thread as WebChatThread,
} from '@utlra/webchat-protocol';
import { upsertWebChatIdentity } from './identity-mapper.js';
import {
  webChatThreadToIr,
  webChatMessageIdToIr,
} from './thread-mapper.js';
import type { WebChatBridgeConfig } from './config.js';
import type { WebChatRestClient } from './rest-client.js';
import { absoluteAttachmentUrl } from './rest-client.js';

export interface InboundDeps {
  config: WebChatBridgeConfig;
  agentSid: string;
  registry: IdentityRegistry;
  assetStore: ChatAssetStore;
  loadThreads: () => LooseThreadStore;
  saveThreads: (data: LooseThreadStore) => void;
  rest: WebChatRestClient;
  /** chat-server 端已知线程的元数据（用于 DM 参与者扩展为 sid 列表）。 */
  resolveThreadMeta: (threadId: string) => WebChatThread | undefined;
  /** 可选：将 user_id 解析为 display_name（用于 thread 首次创建时给参与者起名）。 */
  lookupDisplayName?: (userId: string) => string;
  /** 消息已落库后触发，让 channel 做 trackSeen 并通知 agent。 */
  onMessagePersisted: (ev: {
    threadId: string;
    senderSid: string;
    message: ChatIRInboundMessage;
    participantSids: string[];
  }) => Promise<void>;
}

/** 测试 / 手写 config 可能省略 peerAgentUserIds，默认空集。 */
function peerAgentUserIds(config: WebChatBridgeConfig): Set<string> {
  return config.peerAgentUserIds ?? new Set<string>();
}

export async function handleWebChatInbound(
  deps: InboundDeps,
  msg: WebChatMessage,
): Promise<boolean> {
  if (msg.sender_user_id === deps.config.agentUserId) return false;

  const peerIds = peerAgentUserIds(deps.config);
  const senderKind: 'human' | 'agent' = peerIds.has(msg.sender_user_id)
    ? 'agent'
    : 'human';
  const senderSid = upsertWebChatIdentity(
    deps.registry,
    msg.sender_user_id,
    msg.sender_user_id,
    deps.config.tenant,
    senderKind,
  );

  const irThreadId = webChatThreadToIr(msg.thread_id);
  const wcThread = deps.resolveThreadMeta(msg.thread_id);
  const store = deps.loadThreads();
  let threadRecord = findThreadInStore(store, irThreadId);
  if (!threadRecord) {
    const participantSidsForNew = wcThread
      ? wcThread.participants.map((u) =>
          upsertWebChatIdentity(
            deps.registry,
            u,
            deps.lookupDisplayName?.(u) ?? u,
            deps.config.tenant,
            peerIds.has(u) ? 'agent' : 'human',
          ),
        )
      : [senderSid];
    if (!participantSidsForNew.includes(deps.agentSid)) {
      participantSidsForNew.push(deps.agentSid);
    }
    threadRecord = createThreadRecord({
      thread_id: irThreadId,
      tenant_id: deps.config.tenant,
      channel: 'webchat',
      kind: wcThread?.kind === 'dm' ? 'dm' : 'group',
      title: wcThread?.title,
      participant_sids: dedupe(participantSidsForNew),
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
    // agent IR sid 与 webchat:user:<agentUserId> 并存；下游 onAgentMessage 用 agentSid 判定参与
    if (!ps.includes(deps.agentSid)) {
      ps = [...ps, deps.agentSid];
      changed = true;
    }
    if (changed) {
      threadRecord = { ...threadRecord, participant_sids: dedupe(ps) };
      replaceThreadInStore(store, threadRecord);
    }
  }

  const parts: MessagePart[] = [];
  for (const wcPart of msg.parts) {
    if (wcPart.type === 'text') {
      parts.push({ type: 'text', text: wcPart.text });
    } else if (wcPart.type === 'mention') {
      // 关键：@ 到 agent 自己的 webchat user_id 时，target_sid 必须翻译为 agent 的 IR sid
      // （而不是 `webchat:user:<agentUserId>`），否则 outer-brain 比对 target_sid === agentSid
      // 时永远 false，"是否被 @ 自己"判断失效。与 Discord channel 行为一致。
      if (wcPart.user_id === deps.config.agentUserId) {
        parts.push({
          type: 'mention',
          target_sid: deps.agentSid,
          label: wcPart.display_name,
        });
      } else {
        const sid = upsertWebChatIdentity(
          deps.registry,
          wcPart.user_id,
          wcPart.display_name,
          deps.config.tenant,
          peerIds.has(wcPart.user_id) ? 'agent' : 'human',
        );
        parts.push({ type: 'mention', target_sid: sid, label: wcPart.display_name });
      }
    } else if (wcPart.type === 'attachment') {
      const a = wcPart.attachment;
      let uri = absoluteAttachmentUrl(deps.config.apiBase, a.url);
      if (deps.config.mirrorAssets) {
        const dl = await deps.rest.downloadAttachment(a);
        if (dl) {
          try {
            const saved = deps.assetStore.save(dl.bytes, dl.mime, dl.name);
            uri = `asset:${saved.id}`;
          } catch (e) {
            console.warn('[webchat-bridge] mirror asset failed', a.asset_id, e);
          }
        }
      }
      parts.push({
        type: 'attachment',
        asset_ref: {
          kind: kindFromMime(a.mime),
          uri,
          mime: a.mime,
          name: a.name,
        },
      });
    }
  }

  if (parts.length === 0) return false;

  const messageRecord: MessageRecord = MessageRecordSchema.parse({
    schema: 'message.v1',
    message_id: webChatMessageIdToIr(msg.id),
    thread_id: irThreadId,
    sender_sid: senderSid,
    sent_at: msg.sent_at,
    ...(msg.reply_to_message_id
      ? { reply_to_message_id: webChatMessageIdToIr(msg.reply_to_message_id) }
      : {}),
    parts,
  });

  if (!store.messages[irThreadId]) store.messages[irThreadId] = [];
  store.messages[irThreadId]!.push(messageRecord);
  deps.saveThreads(store);

  const participantSids = threadRecord.participant_sids;

  try {
    await deps.onMessagePersisted({
      threadId: irThreadId,
      senderSid,
      message: messageRecord,
      participantSids,
    });
  } catch (e) {
    console.error('[webchat-bridge] onMessagePersisted error', e);
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

function kindFromMime(mime: string): 'image' | 'video' | 'audio' | 'file' {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}


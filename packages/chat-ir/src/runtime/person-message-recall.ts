/**
 * ADL: personMessageRecall（P3 按人跨会话记忆召回）
 * path: packages/chat-ir/src/runtime/person-message-recall.ts
 * horizon.in:  LooseThreadStore + personSid (+ IdentityBindingIndex 别名集)
 * horizon.out: PersonMessageHit[]（按 sent_at 新→旧，总量/单 thread 上限）
 * @see doc/structurizr/IDENTITY-CROSS-CHANNEL.md §6.5
 *
 * 身份打通的兑现层：同一个人在群聊/私聊/不同渠道的发言进入同一记忆源。
 * 只读 Chat IR，不新增存储；别名集只来自 bindingIndex，不做 display_name 模糊匹配。
 */
import { MessageRecordSchema, type MessageRecord, type ThreadRecord } from '../schemas/message.js';
import { findThread, type LooseThreadStore } from '../thread-store.js';
import type { IdentityBindingIndex } from './identity-binding-index.js';

export interface PersonMessageHit {
  threadId: string;
  /** thread 元数据（渠道/群名/dm），threads[] 缺失时为 null */
  thread: ThreadRecord | null;
  message: MessageRecord;
}

export interface RecallPersonMessagesOptions {
  index?: IdentityBindingIndex | null;
  /** 当前 thread（其历史已单独注入，排除避免重复） */
  excludeThreadId?: string;
  /** 总量上限，默认 12 */
  maxMessages?: number;
  /** 单 thread 上限，默认 4（避免单个话痨群刷满） */
  maxPerThread?: number;
  /** 每 thread 只扫尾部 N 条，默认 50（控制成本） */
  scanTailPerThread?: number;
}

const DEFAULT_MAX_MESSAGES = 12;
const DEFAULT_MAX_PER_THREAD = 4;
const DEFAULT_SCAN_TAIL = 50;

/**
 * 一个人的 sid 别名集：canonical sid 本身 + 其全部 channel_key 的
 * provisional 形态（`<channel>:user:<native_id>`，scope 不进 sid）。
 * linkMerge 不回写历史消息记录，旧消息可能仍带 provisional sid——靠别名集折叠。
 */
export function personSidAliases(
  index: IdentityBindingIndex | null | undefined,
  personSid: string,
): Set<string> {
  const sid = personSid.trim();
  const aliases = new Set<string>([sid]);
  if (!index) return aliases;
  for (const key of index.listKeys(sid)) {
    aliases.add(`${key.channel}:user:${key.native_user_id}`);
  }
  return aliases;
}

/**
 * 跨 thread 召回某人的近期发言（新→旧）。
 */
export function recallPersonMessages(
  data: LooseThreadStore,
  personSid: string,
  opts: RecallPersonMessagesOptions = {},
): PersonMessageHit[] {
  const aliases = personSidAliases(opts.index, personSid);
  const maxMessages = opts.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxPerThread = opts.maxPerThread ?? DEFAULT_MAX_PER_THREAD;
  const scanTail = opts.scanTailPerThread ?? DEFAULT_SCAN_TAIL;

  const all: PersonMessageHit[] = [];
  for (const [threadId, msgs] of Object.entries(data.messages ?? {})) {
    if (threadId === opts.excludeThreadId) continue;
    const perThread: PersonMessageHit[] = [];
    for (const m of (msgs ?? []).slice(-scanTail)) {
      const parsed = MessageRecordSchema.safeParse(m);
      if (!parsed.success) continue;
      if (!aliases.has(parsed.data.sender_sid)) continue;
      perThread.push({ threadId, thread: null, message: parsed.data });
    }
    if (!perThread.length) continue;
    perThread.sort((a, b) => (a.message.sent_at < b.message.sent_at ? 1 : -1));
    const kept = perThread.slice(0, maxPerThread);
    const threadMeta = findThread(data, threadId) ?? null;
    for (const h of kept) h.thread = threadMeta;
    all.push(...kept);
  }

  all.sort((a, b) => (a.message.sent_at < b.message.sent_at ? 1 : -1));
  return all.slice(0, maxMessages);
}

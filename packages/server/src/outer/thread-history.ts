/**
 * 将 IM 线程中**已落库**的消息拼成 goal.md 前缀，供内脑在同一上下文中理解对话。
 */
import {
  MessageRecordSchema,
  serializeMessageForLlm,
  type IdentityRegistry,
  type LooseThreadStore,
  type MessageRecord,
} from '@utlra/chat-ir';
import { resolveAgentTimezone } from '../agent-time.js';

export interface ThreadHistoryOpts {
  /** 最多纳入几条消息（从尾部取） */
  messageLimit: number;
  /** 历史块最大字符数（含标题，不含本轮 assignment） */
  maxChars: number;
}

export interface ThreadHistoryResult {
  /** 空串表示未注入历史 */
  prefix: string;
  messagesIncluded: number;
  /** 因 maxChars 未纳入全部 messageLimit 窗口 */
  truncated: boolean;
}

const DEFAULT_OPTS: ThreadHistoryOpts = {
  messageLimit: 30,
  maxChars: 80_000,
};

export function resolveThreadHistoryOpts(override?: Partial<ThreadHistoryOpts>): ThreadHistoryOpts {
  const envN = process.env['UTLRA_OUTER_THREAD_HISTORY_LIMIT']?.trim();
  const envC = process.env['UTLRA_OUTER_THREAD_HISTORY_MAX_CHARS']?.trim();
  const messageLimit =
    override?.messageLimit ??
    (envN != null && envN !== '' ? Math.min(500, Math.max(0, parseInt(envN, 10) || 0)) : DEFAULT_OPTS.messageLimit);
  const maxChars =
    override?.maxChars ??
    (envC != null && envC !== ''
      ? Math.min(500_000, Math.max(1024, parseInt(envC, 10) || DEFAULT_OPTS.maxChars))
      : DEFAULT_OPTS.maxChars);
  return { messageLimit, maxChars };
}

/**
 * @param rawMessages 追加**当前条**之前的数组
 */
export function buildThreadHistoryPrefix(
  rawMessages: unknown[],
  registry: IdentityRegistry,
  opts: ThreadHistoryOpts,
): ThreadHistoryResult {
  if (opts.messageLimit <= 0 || opts.maxChars <= 0) {
    return { prefix: '', messagesIncluded: 0, truncated: false };
  }

  const parsed: MessageRecord[] = [];
  for (const m of rawMessages) {
    const p = MessageRecordSchema.safeParse(m);
    if (p.success) parsed.push(p.data);
  }

  const window = parsed.slice(-opts.messageLimit);
  if (window.length === 0) {
    return { prefix: '', messagesIncluded: 0, truncated: false };
  }

  const picked: MessageRecord[] = [];
  let usedChars = 0;
  const header =
    '<!-- utlra: IM thread history (outer brain context) -->\n\n## Thread history\n\n';
  usedChars = header.length;

  const tz = resolveAgentTimezone();
  for (let i = window.length - 1; i >= 0; i--) {
    const msg = window[i]!;
    const sender = registry.get(msg.sender_sid);
    const line = serializeMessageForLlm(
      msg,
      sender?.display_name ?? msg.sender_sid,
      sender?.kind ?? 'human',
      tz,
    );
    const chunk = line + '\n\n';
    if (usedChars + chunk.length > opts.maxChars) break;
    picked.unshift(msg);
    usedChars += chunk.length;
  }

  const truncated = picked.length < window.length;
  if (picked.length === 0) {
    return { prefix: '', messagesIncluded: 0, truncated: window.length > 0 };
  }

  const body = picked
    .map((msg) => {
      const sender = registry.get(msg.sender_sid);
      return serializeMessageForLlm(
        msg,
        sender?.display_name ?? msg.sender_sid,
        sender?.kind ?? 'human',
        tz,
      );
    })
    .join('\n\n');

  const prefix = `${header}${body}\n\n---\n\n## Current assignment (outer → inner)\n\n`;
  return { prefix, messagesIncluded: picked.length, truncated };
}

/** 心跳闲聊 / post_to_im 默认纳入的最近消息条数 */
export const HEARTBEAT_THREAD_MSG_LIMIT = 12;
/** 心跳闲聊 / post_to_im 默认历史字符上限 */
export const HEARTBEAT_THREAD_MAX_CHARS = 6_000;

export interface RecentThreadMessagesResult {
  /** 空串表示线程无可用历史 */
  text: string;
  messageCount: number;
  lastSenderSid: string | null;
  /** 纳入窗口内是否有人类消息 */
  hasHumanMessage: boolean;
}

/**
 * 从落库线程读取最近消息，格式化为 LLM 可读的对话块（心跳闲聊、post_to_im 决策用）。
 */
export function formatRecentThreadMessagesForLlm(
  threadId: string,
  loadThreads: () => LooseThreadStore,
  registry: IdentityRegistry,
  override?: Partial<ThreadHistoryOpts>,
): RecentThreadMessagesResult {
  const opts = resolveThreadHistoryOpts({
    messageLimit: override?.messageLimit ?? HEARTBEAT_THREAD_MSG_LIMIT,
    maxChars: override?.maxChars ?? HEARTBEAT_THREAD_MAX_CHARS,
  });
  if (!threadId.trim() || opts.messageLimit <= 0 || opts.maxChars <= 0) {
    return { text: '', messageCount: 0, lastSenderSid: null, hasHumanMessage: false };
  }

  const raw = (loadThreads().messages[threadId] ?? []).slice(-opts.messageLimit);
  const built = buildThreadHistoryPrefix(raw, registry, opts);
  if (built.messagesIncluded === 0) {
    return { text: '', messageCount: 0, lastSenderSid: null, hasHumanMessage: false };
  }

  const parsed: MessageRecord[] = [];
  for (const m of raw) {
    const p = MessageRecordSchema.safeParse(m);
    if (p.success) parsed.push(p.data);
  }
  const window = parsed.slice(-built.messagesIncluded);
  const last = window[window.length - 1] ?? null;
  const tz = resolveAgentTimezone();
  const body = window
    .map((msg) => {
      const sender = registry.get(msg.sender_sid);
      return serializeMessageForLlm(
        msg,
        sender?.display_name ?? msg.sender_sid,
        sender?.kind ?? 'human',
        tz,
      );
    })
    .join('\n\n');

  const hasHumanMessage = window.some((msg) => {
    const kind = registry.get(msg.sender_sid)?.kind ?? 'human';
    return kind === 'human';
  });

  return {
    text: body,
    messageCount: window.length,
    lastSenderSid: last?.sender_sid ?? null,
    hasHumanMessage,
  };
}

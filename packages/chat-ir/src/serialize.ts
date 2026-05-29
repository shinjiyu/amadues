/**
 * Chat IR 序列化工具 —— 把数据模型转成喂给 LLM 的固定文本块。
 *
 * 三个函数：
 * - `formatMessageTime`：把 ISO 时间格式化为「绝对+相对」（"今天 14:32（3分钟前）"）
 * - `serializeMessageForLlm`：单条 `MessageRecord` → 带说话者头与时间标签的一段
 * - `serializeIdentityPack`：完整 `IdentityContextPack` → [SELF] / [PARTICIPANTS] / [ROLES] / [PRONOUNS] 块
 *
 * 这些都是纯函数，无 fs / 无 env，可以在任何 JS 环境运行。
 */
import type { MessageRecord } from './schemas/message.js';
import type { IdentityRecord } from './schemas/identity.js';

export interface FormatMessageTimeOptions {
  /** IANA 时区；默认 Asia/Shanghai（与 agent get_time 一致） */
  timeZone?: string;
  /** 用于「今天/昨天」比较的参考时刻 */
  now?: Date;
}

export const DEFAULT_AGENT_TIMEZONE = 'Asia/Shanghai';
const DEFAULT_MESSAGE_TIMEZONE = DEFAULT_AGENT_TIMEZONE;

function datePartsInTimeZone(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: pick('year'),
    month: Number(pick('month')),
    day: Number(pick('day')),
    hour: pick('hour'),
    minute: pick('minute'),
  };
}

/**
 * 格式化消息时间标签，让 LLM 感知对话的时间节奏。
 * 格式：绝对时间 + 相对时间，如 "今天 14:32（3分钟前）"、"4月5日 09:10（昨天）"。
 *
 * 使用显式 IANA 时区，避免进程 TZ=UTC 时把 UTC 钟点当成本地时间（典型 ±8h 偏差）。
 */
export function formatMessageTime(sentAt: string, options?: FormatMessageTimeOptions): string {
  const msgDate = new Date(sentAt);
  if (isNaN(msgDate.getTime())) return '';

  const timeZone = options?.timeZone ?? DEFAULT_MESSAGE_TIMEZONE;
  const now = options?.now ?? new Date();
  const diffMs = now.getTime() - msgDate.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMs / 3_600_000);
  const diffDay = Math.floor(diffMs / 86_400_000);

  let relative: string;
  if (diffMs < 60_000) relative = '刚刚';
  else if (diffMin < 60) relative = `${diffMin}分钟前`;
  else if (diffHr < 24) relative = `${diffHr}小时前`;
  else if (diffDay === 1) relative = '昨天';
  else if (diffDay < 30) relative = `${diffDay}天前`;
  else relative = `${Math.floor(diffDay / 30)}个月前`;

  const mp = datePartsInTimeZone(msgDate, timeZone);
  const np = datePartsInTimeZone(now, timeZone);
  const hhmm = `${mp.hour}:${mp.minute}`;
  const isToday = mp.year === np.year && mp.month === np.month && mp.day === np.day;
  const abs = isToday
    ? `今天 ${hhmm}`
    : `${mp.month}月${mp.day}日 ${hhmm}`;

  return `${abs}（${relative}）`;
}

export interface FormatWallClockTimeOptions {
  /** IANA 时区；默认 Asia/Shanghai */
  timeZone?: string;
  /** 今天只显示 HH:mm；false 时始终带月/日 */
  compactToday?: boolean;
  /** 是否包含秒 */
  withSeconds?: boolean;
}

/**
 * 墙钟时间（UI / 日志），使用显式 IANA 时区。
 * 接受 ISO 字符串、Date 或 epoch 毫秒。
 */
export function formatWallClockTime(
  input: string | Date | number,
  options?: FormatWallClockTimeOptions,
): string {
  const date =
    typeof input === 'number'
      ? new Date(input)
      : typeof input === 'string'
        ? new Date(input)
        : input;
  if (Number.isNaN(date.getTime())) return '';

  const timeZone = options?.timeZone ?? DEFAULT_MESSAGE_TIMEZONE;
  const mp = datePartsInTimeZone(date, timeZone);
  const now = new Date();
  const np = datePartsInTimeZone(now, timeZone);
  let hhmm: string;
  if (options?.withSeconds) {
    hhmm = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(date);
  } else {
    hhmm = `${mp.hour}:${mp.minute}`;
  }
  const compactToday = options?.compactToday ?? true;
  if (compactToday) {
    const isToday = mp.year === np.year && mp.month === np.month && mp.day === np.day;
    if (isToday) return hhmm;
    return `${mp.month}/${mp.day} ${hhmm}`;
  }
  return `${mp.year}-${mp.month}-${mp.day} ${hhmm}`;
}

/** 多说话者：每条消息带头（含时间标签）再序列化 parts */
export function serializeMessageForLlm(
  msg: MessageRecord,
  senderDisplayName: string,
  senderKind: string,
  timeZone?: string,
): string {
  const timeTag = msg.sent_at ? formatMessageTime(msg.sent_at, { timeZone }) : '';
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

/**
 * 喂给外脑 LLM 的固定身份块——由 `IdentityRegistry.packForThread()` 等运行时构造，
 * 经 `serializeIdentityPack` 序列化后作为 system / prefix 注入。
 */
export interface IdentityContextPack {
  self: IdentityRecord;
  participants: IdentityRecord[];
  threadSummary: { thread_id: string; tenant_id: string; kind: 'dm' | 'group' };
}

/** 将 Pack 序列化为给 LLM 的固定块（不含具体消息正文） */
export function serializeIdentityPack(pack: IdentityContextPack): string {
  const uniqParticipants = (() => {
    const out: IdentityRecord[] = [];
    const seen = new Set<string>();
    for (const p of [pack.self, ...pack.participants]) {
      if (seen.has(p.sid)) continue;
      seen.add(p.sid);
      out.push(p);
    }
    return out;
  })();
  const lines: string[] = [
    '[SELF]',
    `sid=${pack.self.sid} name=${pack.self.display_name} kind=${pack.self.kind}`,
    '',
    '[PARTICIPANTS]',
    ...pack.participants.map(
      (p) => `sid=${p.sid} name=${p.display_name} kind=${p.kind} aliases=${p.aliases.join(',')}`,
    ),
    '',
    '[ROLES]',
    ...uniqParticipants.map((p) => {
      const rs = p.roles_in_tenant?.length ? p.roles_in_tenant.join(',') : '（未标注）';
      return `${p.sid}: ${rs}`;
    }),
    '',
    '[THREAD]',
    `thread_id=${pack.threadSummary.thread_id} tenant=${pack.threadSummary.tenant_id} kind=${pack.threadSummary.kind}`,
    '',
    '[PRONOUNS]',
    '「你」= 本栈主助手（上列 [SELF]，sid=' +
      pack.self.sid +
      '）；「我」= 该条消息头 from:sid 中的说话者（每条消息不同，多 agent 时勿与 [SELF] 混淆）。',
  ];
  return lines.join('\n');
}

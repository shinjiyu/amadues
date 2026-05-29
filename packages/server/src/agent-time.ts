/**
 * Agent 侧「当前时间」统一时区（外脑 get_time、聊天 now 标签、心跳上下文）。
 *
 * 默认 Asia/Shanghai。可用 `UTLRA_AGENT_TIMEZONE` 或进程 `TZ` 覆盖。
 * 避免 get_time 返回 UTC(Z) 而其它提示用本地时间，导致 LLM 误判「任务已跑 8 小时」。
 */
export const DEFAULT_AGENT_TIMEZONE = 'Asia/Shanghai';

export function resolveAgentTimezone(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['UTLRA_AGENT_TIMEZONE']?.trim();
  if (explicit) return explicit;
  const tz = env['TZ']?.trim();
  if (tz) return tz;
  return DEFAULT_AGENT_TIMEZONE;
}

/** 外脑/内脑 get_time 与人类可读的本地时间字符串（含时区缩写）。 */
export function formatAgentLocalDateTime(
  date: Date = new Date(),
  timezone: string = resolveAgentTimezone(),
): string {
  return date.toLocaleString('zh-CN', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  });
}

/** 聊天注入用的短标签，例如 `【现在 17:15 Asia/Shanghai】` */
export function formatAgentNowTag(date: Date = new Date(), timezone?: string): string {
  const tz = timezone ?? resolveAgentTimezone();
  const hh = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
  return `【现在 ${hh} ${tz}】`;
}

/** 将 ISO 8601 时刻格式化为 agent 本地时间（工具 JSON 输出用，避免裸 UTC Z 误导 LLM） */
export function formatAgentIsoLocal(iso: string, timezone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return formatAgentLocalDateTime(d, timezone ?? resolveAgentTimezone());
}

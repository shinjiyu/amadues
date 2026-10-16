/**
 * User-visible speech boundary.
 * Adapters may think in their own runtime vocabulary. Text that leaves the host
 * must not teach the user those words.
 *
 * @see doc/structurizr/AGENT-HOST.md §4
 */

export const USER_SPEECH_PROMPT =
  '对用户说话时不要出现这些词：内脑、外脑、KPI、burst、set_goal、任务 ID。' +
  '开始做说「我去做」，做完说「做完了」，等人补充说「需要你补一句」。';

const PHRASES: Array<[RegExp, string]> = [
  [/⏸\s*内脑任务等待您的输入/g, '⏸ 需要你补一句'],
  [/❌\s*内脑任务失败（[^）\n]*）/g, '❌ 这件没做成'],
  [/❌\s*内脑任务失败/g, '❌ 这件没做成'],
  [/⚠️\s*内脑任务部分完成（未完全达成目标）/g, '⚠️ 做了一部分，还没完成'],
  [/⚠️\s*内脑任务被阻塞，需要您的输入/g, '⚠️ 需要你补一句'],
  [/内脑任务已完成/g, '做完了'],
  [/已派内脑/g, '我去做'],
  [/已建 KPI[^\n，。]*/g, '我会接着做'],
  [/\*\*任务 ID\*\*[：:][^\n]*/g, ''],
  [/内脑/g, ''],
  [/外脑/g, ''],
  [/\bKPI\b/g, ''],
  [/\bburst\b/gi, ''],
  [/set_goal/g, ''],
];

/** Rewrite one user-visible string. Internal logs must not call this. */
export function toUserSpeech(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PHRASES) {
    out = out.replace(pattern, replacement);
  }
  return out
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/g, ''))
    .filter((line, index, all) => {
      if (line.trim() !== '') return true;
      const prev = all[index - 1];
      return prev !== undefined && prev.trim() !== '';
    })
    .join('\n')
    .trim();
}

/**
 * System notices must not be treated as a human reply.
 * Keeps the legacy 内脑 templates so old threads still match.
 */
export function isHostNotificationEcho(text: string): boolean {
  const t = text.trim();
  if (/^✅/.test(t)) return true;
  if (/^❌\s*(?:内脑任务失败|这件没做成)/.test(t)) return true;
  if (/^⚠️\s*(?:内脑任务部分完成|内脑任务被阻塞|做了一部分|需要你补一句)/.test(t)) return true;
  if (/^⏸\s*(?:内脑任务等待您的输入|需要你补一句)/.test(t)) return true;
  return false;
}

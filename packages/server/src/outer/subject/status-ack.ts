import { HOUR_MS, STATUS_CODE_POINTS } from './constants.js';
import { truncateCodePoints } from './text.js';

export type StatusReaction = 'seen' | 'later' | 'working';

export function deferHours(deferRevisitMs: number): number {
  return Math.max(1, Math.round(deferRevisitMs / HOUR_MS));
}

export function formatUtcMinute(iso: string): string {
  const ms = Date.parse(iso);
  const date = new Date(Number.isFinite(ms) ? ms : Date.now());
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

export function statusText(input: {
  action: string;
  deferRevisitMs: number;
  revisitAt?: string;
  proposalDispatched?: boolean;
}): string {
  const hours = deferHours(input.deferRevisitMs);
  let text: string;
  switch (input.action) {
    case 'no_reply':
      text = '〔状态〕看到了，这轮不聊。';
      break;
    case 'do_nothing':
      text = '〔状态〕看到了，这轮不做。';
      break;
    case 'wait':
      text = '〔状态〕这轮先停着。';
      break;
    case 'defer':
      text = `〔状态〕先搁下，${hours} 小时后再看。`;
      break;
    case 'schedule_revisit':
      text = `〔状态〕改到 ${formatUtcMinute(input.revisitAt ?? new Date().toISOString())} UTC 再看。`;
      break;
    case 'lease_held':
      text = '〔状态〕上一次还没想完，这轮先记下。';
      break;
    case 'propose_self_work':
      text = input.proposalDispatched
        ? '〔状态〕不在这里接话，我按自己的安排去做。'
        : `〔状态〕先搁下，${hours} 小时后再看。`;
      break;
    default:
      text = '〔状态〕这轮先停着。';
  }
  return truncateCodePoints(text, STATUS_CODE_POINTS);
}

export function reactionFor(action: string, proposalDispatched = false): StatusReaction {
  if (action === 'no_reply' || action === 'do_nothing') return 'seen';
  if (action === 'propose_self_work' && proposalDispatched) return 'working';
  return 'later';
}

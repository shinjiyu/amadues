import { describe, expect, it } from 'vitest';

import { decide, ensureDoNothingAndDefer } from './decide.js';
import type { Candidate, SubjectDrives } from './types.js';

const drives: SubjectDrives = { curiosity: 0.2, social: 0.4, completion: 0.1 };

function candidate(action: string, args: Record<string, unknown> = {}): Candidate {
  return { action, args };
}

describe('subjectDecide', () => {
  it('picks the high legal score and adds drive weight', () => {
    const chosen = decide({
      candidates: [candidate('reply_to_thread', { text: '在' })],
      scores: [{ action: 'reply_to_thread', score: 0.9 }],
      drives,
    });
    expect(chosen.chosen?.action).toBe('reply_to_thread');
    expect(chosen.total).toBeCloseTo(0.9 + 0.3 * 0.4);
  });

  it('rejects an action outside the allowlist', () => {
    const chosen = decide({
      candidates: [candidate('delete_memory')],
      scores: [{ action: 'delete_memory', score: 1 }],
      drives,
    });
    expect(chosen.rejected).toEqual([{ action: 'delete_memory', why: '不在行动白名单内' }]);
    expect(chosen.chosen?.action).toBe('do_nothing');
    expect(chosen.reason).toBe('无合法候选');
  });

  it('injects do_nothing and defer before scoring', () => {
    const filled = ensureDoNothingAndDefer([candidate('reply_to_thread', { text: '好' })]);
    expect(filled.map((row) => row.action)).toEqual(['reply_to_thread', 'do_nothing', 'defer']);
  });

  it('breaks ties by action name ascending', () => {
    const chosen = decide({
      candidates: [candidate('wait'), candidate('defer'), candidate('no_reply')],
      scores: [
        { action: 'wait', score: 0 },
        { action: 'defer', score: 0 },
        { action: 'no_reply', score: 0 },
      ],
      drives,
    });
    expect(chosen.chosen?.action).toBe('defer');
  });

  it('does not accept a privileged sid', () => {
    type DecideInput = Parameters<typeof decide>[0];
    type HasSid = 'sid' extends keyof DecideInput ? true : false;
    const noSid: HasSid = false;
    expect(noSid).toBe(false);
    const input = {
      candidates: [candidate('no_reply'), candidate('defer')],
      scores: [
        { action: 'no_reply', score: 0.2 },
        { action: 'defer', score: 0.2 },
      ],
      drives,
    };
    expect(decide(input).chosen?.action).toBe(decide({ ...input }).chosen?.action);
  });
});

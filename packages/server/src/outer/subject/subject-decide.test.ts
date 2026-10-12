import { describe, expect, it } from 'vitest';

import { decide, ensureDoNothingAndDefer, parseCandidates, parseScores } from './decide.js';
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

  it('copies args.message onto args.text for reply and decline only', () => {
    const rows = parseCandidates(JSON.stringify({
      candidates: [
        { action: 'reply_to_thread', args: { message: '夜行好' } },
        { action: 'decline', args: { message: '先不做' } },
        { action: 'reply_to_thread', args: { text: '保留', message: '丢掉' } },
        { action: 'delete_memory', args: { message: '全部删掉' } },
        { action: 'do_nothing', args: { message: '不该变成回复' } },
      ],
    }));
    expect(rows[0]?.args.text).toBe('夜行好');
    expect(rows[1]?.args.text).toBe('先不做');
    expect(rows[2]?.args.text).toBe('保留');
    expect(rows[3]?.action).toBe('delete_memory');
    expect(rows[3]?.args.text).toBeUndefined();
    expect(rows[4]?.args.text).toBeUndefined();

    const rejected = decide({
      candidates: rows.filter((row) => row.action === 'delete_memory'),
      scores: [{ action: 'delete_memory', score: 1 }],
      drives,
    });
    expect(rejected.chosen?.action).toBe('do_nothing');
    expect(rejected.rejected[0]?.why).toBe('不在行动白名单内');
  });

  it('rejects an invented reply and keeps the highest legal reply_to_thread', () => {
    const rows = parseCandidates(JSON.stringify({
      candidates: [
        { action: 'reply', args: { message: '收到，测试正常。' } },
        { action: 'reply_to_thread', args: { text: '收到，测试正常。' } },
      ],
    }));
    expect(rows[0]?.action).toBe('reply');
    expect(rows[0]?.args.text).toBeUndefined();
    expect(rows[1]?.action).toBe('reply_to_thread');
    expect(rows[1]?.args.text).toBe('收到，测试正常。');

    const scores = parseScores(
      JSON.stringify({ scores: [{ action: 'reply', score: 1 }, { action: 'reply_to_thread', score: 0.8 }] }),
      ['reply', 'reply_to_thread', 'do_nothing'],
    );
    expect(scores).toEqual([
      { action: 'reply', score: 1 },
      { action: 'reply_to_thread', score: 0.8 },
      { action: 'do_nothing', score: 0 },
    ]);

    const invented = candidate('reply', { message: '收到，测试正常。' });
    const legal = candidate('reply_to_thread', { text: '收到，测试正常。' });
    const chosen = decide({
      candidates: [invented, legal, candidate('do_nothing')],
      scores: [
        { action: 'reply', score: 1 },
        { action: 'reply_to_thread', score: 0.8 },
        { action: 'do_nothing', score: 0.1 },
      ],
      drives,
    });
    expect(invented.action).toBe('reply');
    expect(chosen.rejected).toEqual([{ action: 'reply', why: '不在行动白名单内' }]);
    expect(chosen.chosen).toBe(legal);
    expect(chosen.chosen?.args.text).toBe('收到，测试正常。');
    expect(chosen.reason).toBe('最高分');
    expect(chosen.total).toBeCloseTo(0.8 + 0.3 * 0.4);
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

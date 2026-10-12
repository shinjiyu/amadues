import { describe, expect, it } from 'vitest';

import { DEFAULT_IDENTITY, NORTH_STAR_TEXT } from './constants.js';
import type { WorkObject } from './work-object.js';
import {
  WORK_EXECUTION,
  WORK_OPS,
  finishWorkObject,
  parseWorkProposals,
  projectWorkObject,
  projectWorkOp,
  seedWorkObjects,
  selectWorkPoint,
  workScore,
} from './work-object.js';

describe('subjectWorkObject', () => {
  it('keeps abstract ops distinct from their execution kinds', () => {
    for (const op of WORK_OPS) {
      const projected = projectWorkOp(op);
      expect(projected?.op).toBe(op);
      expect(projected?.execution).toBe(WORK_EXECUTION[op]);
      expect(projected?.execution).not.toBe(op);
    }
    const point = projectWorkObject({ op: 'explore', label: '还没核对的缺口' });
    expect(point).toEqual({
      execution: 'open_question',
      goalText: '还没核对的缺口',
      expectedOutcome: '一个仍开放的问题和两条可核对线索',
    });
  });

  it('applies interestingness weights and inverts cost and risk', () => {
    const high = workScore({
      interestingness: 0.9,
      novelty: 0.8,
      valueToMissions: 0.7,
      cost: 0.2,
      risk: 0.1,
    });
    const costly = workScore({
      interestingness: 0.9,
      novelty: 0.8,
      valueToMissions: 0.7,
      cost: 0.9,
      risk: 0.8,
    });
    expect(high).toBeCloseTo((1.2 * 0.9 + 0.35 * 0.8 + 0.7 + 0.7 * 0.8 + 0.9 * 0.9) / 4.15);
    expect(costly).toBeLessThan(high);
  });

  it('rejects invented tool names and unknown ops', () => {
    const parsed = parseWorkProposals([
      { kind: 'question', label: '跑一条命令', op: 'shell', interestingness: 1 },
      { kind: 'set_goal', label: '改目标', op: 'explore' },
      { kind: 'theme', label: '删记忆', op: 'delete_memory' },
      { kind: 'theme', label: '随便做', op: 'invent_tool' },
      { kind: 'question', label: '核对缺口', op: 'explore', interestingness: 0.4 },
    ]);
    expect(parsed.rejected.map((row) => row.why)).toEqual([
      '工具名不能进入工作对象空间',
      '工具名不能进入工作对象空间',
      '工具名不能进入工作对象空间',
      '不是工作操作',
    ]);
    expect(parsed.accepted).toHaveLength(1);
    expect(parsed.accepted[0]?.op).toBe('explore');
    expect(projectWorkOp('shell')).toBeNull();
    expect(projectWorkOp('set_goal')).toBeNull();
    expect(projectWorkOp('delete_memory')).toBeNull();
  });

  it('seeds subject roots and skips a servant goal', () => {
    const seeded = seedWorkObjects({
      identity: DEFAULT_IDENTITY,
      goals: [
        { id: 'g-chore', text: '把正在做的事做完', priority: 0.9 },
        { id: 'g-own', text: '我还想慢慢弄明白的事', priority: 0.5 },
      ],
      curiosity: 0.9,
      idle: true,
    });
    expect(seeded.map((row) => row.source)).toEqual(expect.arrayContaining(['identity', 'north_star', 'commitment', 'curiosity']));
    expect(seeded.some((row) => row.source === 'observation')).toBe(false);
    expect(seeded.some((row) => row.label.includes('把正在做的事做完'))).toBe(false);
    expect(seeded.find((row) => row.source === 'north_star')?.label).toBe(NORTH_STAR_TEXT);
    const chosen = selectWorkPoint(seeded, 0.9, true);
    expect(chosen?.source).toBe('north_star');
    expect(projectWorkObject(chosen!).execution).toBe('open_question');

    const busy = seedWorkObjects({
      identity: DEFAULT_IDENTITY,
      goals: [{ id: 'g-own', text: '我还想慢慢弄明白的事', priority: 0.5 }],
      curiosity: 0.9,
      idle: false,
    });
    expect(busy.some((row) => row.source === 'curiosity')).toBe(false);
  });

  it('rejects service-shaped proposals and copies of an existing root', () => {
    const roots = [{ label: NORTH_STAR_TEXT }];
    const parsed = parseWorkProposals([
      { kind: 'question', label: '把用户搁置的需求收尾', op: 'explore', interestingness: 1, novelty: 1 },
      { kind: 'theme', label: NORTH_STAR_TEXT, op: 'explore', source: 'north_star', interestingness: 1 },
      { kind: 'theme', label: '帮我看一下仓库', op: 'gather', interestingness: 1 },
    ], (hint) => hint, roots);
    expect(parsed.accepted).toHaveLength(0);
    expect(parsed.rejected.map((row) => row.why)).toEqual([
      '这是替人收尾，不是我自己的兴趣',
      '不要填已有的根',
      '这是替人收尾，不是我自己的兴趣',
    ]);
  });

  it('lets a familiar theme beat a merely novel question, and a lively divergence beat the familiar theme', () => {
    const seeded = seedWorkObjects({
      identity: DEFAULT_IDENTITY,
      goals: [{ id: 'g-own', text: '我还想慢慢弄明白的事', priority: 0.5 }],
      curiosity: 0.9,
      idle: true,
    });
    const mildNovel = parseWorkProposals([{
      id: 'wo-new',
      kind: 'question',
      label: '一个还没什么感觉的新问题',
      op: 'explore',
      relatesTo: ['g-north'],
      interestingness: 0.45,
      novelty: 0.99,
      valueToMissions: 0.4,
      cost: 0.3,
      risk: 0.2,
    }], (hint) => hint, seeded).accepted[0]!;
    expect(selectWorkPoint([...seeded, mildNovel], 0.9, true)?.source).toBe('north_star');

    const divergence = parseWorkProposals([{
      id: 'wo-lamp',
      kind: 'theme',
      label: '夜里的灯为什么显得近',
      op: 'explore',
      relatesTo: ['g-north'],
      interestingness: 0.98,
      novelty: 0.22,
      valueToMissions: 0.86,
      cost: 0.15,
      risk: 0.1,
    }], (hint) => hint, seeded).accepted[0]!;
    const chosen = selectWorkPoint([...seeded, divergence], 0.9, true);
    expect(chosen?.id).toBe('wo-lamp');
    expect(chosen?.source).toBe('proposal');
    expect(projectWorkObject(chosen!).execution).toBe('open_question');
  });

  it('downranks a perfect human observation while idle', () => {
    const seeded = seedWorkObjects({
      identity: DEFAULT_IDENTITY,
      curiosity: 0.9,
      idle: true,
    });
    const observation: WorkObject = {
      id: 'wo-obs',
      kind: 'evidence',
      label: '别人留下的材料',
      op: 'compare',
      source: 'observation',
      relatesTo: [],
      status: 'open',
      dims: { interestingness: 1, novelty: 1, valueToMissions: 1, cost: 0, risk: 0 },
    };
    expect(selectWorkPoint([...seeded, observation], 0.9, true)?.source).toBe('north_star');
  });

  it('finishes an explore object and leaves a return to that theme', () => {
    const seeded = seedWorkObjects({
      identity: DEFAULT_IDENTITY,
      goals: [{ id: 'g-own', text: '我还想慢慢弄明白的事', priority: 0.5 }],
      curiosity: 0.2,
      idle: true,
    });
    const next = finishWorkObject(seeded, seeded[0]!.id, (hint) => hint);
    expect(next.find((row) => row.id === seeded[0]!.id)?.status).toBe('done');
    const follow = next.find((row) => row.source === 'follow_on');
    expect(follow?.op).toBe('explore');
    expect(follow?.relatesTo).toEqual([seeded[0]!.id]);
    expect(follow?.label).toContain(seeded[0]!.label);
  });
});

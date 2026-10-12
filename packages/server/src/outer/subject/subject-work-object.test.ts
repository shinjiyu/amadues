import { describe, expect, it } from 'vitest';

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
    expect(high).toBeCloseTo((1.2 * 0.9 + 0.8 * 0.8 + 0.7 + 0.7 * 0.8 + 0.9 * 0.9) / 4.6);
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

  it('selects a curiosity object when idle and no human assigned the work', () => {
    const seeded = seedWorkObjects({
      goals: [{ id: 'g-default', text: '把正在做的事做完', priority: 0.5 }],
      observations: ['已经看过的材料'],
      residues: [],
      curiosity: 0.9,
      idle: true,
    });
    expect(seeded.some((row) => row.source === 'curiosity')).toBe(true);
    expect(seeded.find((row) => row.source === 'observation')?.op).toBe('gather');
    const chosen = selectWorkPoint(seeded, 0.9, true);
    expect(chosen?.source).toBe('curiosity');
    expect(chosen?.label).toBe('什么是我还没核对、但和当前目标有关的缺口');
    expect(projectWorkObject(chosen!).execution).toBe('open_question');

    const busy = seedWorkObjects({
      goals: [{ id: 'g-default', text: '把正在做的事做完', priority: 0.5 }],
      observations: [],
      residues: [],
      curiosity: 0.9,
      idle: false,
    });
    expect(busy.some((row) => row.source === 'curiosity')).toBe(false);
  });

  it('lets a more interesting open object outrank the curiosity seed', () => {
    const seeded = seedWorkObjects({
      goals: [{ id: 'g-default', text: '把正在做的事做完', priority: 0.5 }],
      observations: [],
      residues: [],
      curiosity: 0.9,
      idle: true,
    });
    const vivid = parseWorkProposals([{
      id: 'wo-vivid',
      kind: 'evidence',
      label: '两份材料互相矛盾',
      op: 'compare',
      source: 'observation',
      interestingness: 1,
      novelty: 1,
      valueToMissions: 1,
      cost: 0,
      risk: 0,
    }]).accepted[0]!;
    const chosen = selectWorkPoint([...seeded, vivid], 0.9, true);
    expect(chosen?.id).toBe('wo-vivid');
    expect(projectWorkObject(chosen!).execution).toBe('compare_notes');
  });

  it('finishes an explore object and leaves a follow-on question', () => {
    const seeded = seedWorkObjects({
      goals: [{ id: 'g-default', text: '把正在做的事做完', priority: 0.5 }],
      observations: [],
      residues: [],
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

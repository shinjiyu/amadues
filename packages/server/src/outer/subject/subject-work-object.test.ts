import { describe, expect, it } from 'vitest';

import { DEFAULT_GOAL_TEXT, DEFAULT_IDENTITY, NORTH_STAR_TEXT } from './constants.js';
import type { WorkObject } from './work-object.js';
import {
  WORK_EXECUTION,
  WORK_OPS,
  acceptWorkDescription,
  buildWorkDescribeUser,
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
    });
  });

  it('accepts a living description and rejects empty, servant, and canned outcomes', () => {
    const object = { label: '想成为宝可梦大师', kind: 'theme' as const, op: 'explore' as const };
    const prompt = buildWorkDescribeUser(object);
    expect(prompt).toContain('[TASK:DESCRIBE]');
    expect(prompt).toContain('想成为宝可梦大师');
    expect(prompt).toContain('explore');
    expect(prompt).toContain('对战');
    expect(prompt).toContain('拆开来想');
    expect(prompt).toContain('开放式探讨');
    expect(prompt).not.toContain('open_question');
    expect(prompt).toContain('一个仍开放的问题和两条可核对线索');

    const accepted = acceptWorkDescription(
      '{"goalText":"想成为宝可梦大师，先去打一场对战","expectedOutcome":"我想成为宝可梦大师，先去打一场对战。"}',
      object,
    );
    expect(accepted).toEqual({
      ok: true,
      goalText: '想成为宝可梦大师，先去打一场对战',
      expectedOutcome: '我想成为宝可梦大师，先去打一场对战。',
    });
    expect(acceptWorkDescription(
      '{"goalText":"想成为宝可梦大师","expectedOutcome":"我想成为宝可梦大师，先去收集一只精灵的对战记录。"}',
      object,
    )).toEqual({
      ok: true,
      goalText: '我想成为宝可梦大师，先去收集一只精灵的对战记录。',
      expectedOutcome: '我想成为宝可梦大师，先去收集一只精灵的对战记录。',
    });
    expect(acceptWorkDescription('{"expectedOutcome":""}', object)).toMatchObject({ ok: false, why: '产物说明是空的' });
    expect(acceptWorkDescription(
      '{"expectedOutcome":"帮用户把想成为宝可梦大师这件事收尾"}',
      object,
    )).toMatchObject({ ok: false, why: '产物说明是替人收尾' });
    expect(acceptWorkDescription(
      '{"expectedOutcome":"围绕「想成为宝可梦大师」：一个仍开放的问题和两条可核对线索"}',
      object,
    )).toMatchObject({ ok: false, why: '产物说明是套话' });
    expect(acceptWorkDescription(
      '{"expectedOutcome":"把想成为宝可梦大师拆开来想"}',
      object,
    )).toMatchObject({ ok: false, why: '产物说明是在分析' });
    expect(acceptWorkDescription(
      '{"expectedOutcome":"对想成为宝可梦大师做一次开放式探讨"}',
      object,
    )).toMatchObject({ ok: false, why: '产物说明是在分析' });
    expect(acceptWorkDescription(
      '{"expectedOutcome":"想成为宝可梦大师先放着"}',
      object,
    )).toMatchObject({ ok: false, why: '产物说明不是可做的一步' });
    expect(acceptWorkDescription(
      '{"expectedOutcome":"写成一段和这件事无关的旧故事"}',
      object,
    )).toMatchObject({ ok: false, why: '产物说明没有落到这个对象上' });
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
        { id: 'g-own', text: DEFAULT_GOAL_TEXT, priority: 0.5 },
      ],
      curiosity: 0.9,
      idle: true,
    });
    expect(seeded.map((row) => row.source)).toEqual(expect.arrayContaining(['identity', 'north_star', 'curiosity']));
    expect(seeded.some((row) => row.source === 'commitment')).toBe(false);
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

  it('dispatches a concrete commitment instead of the north-star slogan', () => {
    const seeded = seedWorkObjects({
      identity: DEFAULT_IDENTITY,
      goals: [
        { id: 'g-poke', text: '想成为宝可梦大师', priority: 0.8 },
        { id: 'g-filler', text: DEFAULT_GOAL_TEXT, priority: 0.95 },
      ],
      curiosity: 0.9,
      idle: true,
    });
    const proposals = parseWorkProposals([
      {
        id: 'wo-train',
        kind: 'theme',
        label: '训练一只皮卡丘',
        op: 'explore',
        interestingness: 0.62,
        novelty: 0.4,
        valueToMissions: 0.5,
        cost: 0.3,
        risk: 0.2,
      },
      {
        id: 'wo-badge',
        kind: 'question',
        label: '道馆徽章要怎么凑齐',
        op: 'gather',
        interestingness: 0.58,
        novelty: 0.55,
        valueToMissions: 0.5,
        cost: 0.35,
        risk: 0.2,
      },
    ], (hint) => hint, seeded).accepted;
    const chosen = selectWorkPoint([...seeded, ...proposals], 0.9, true);
    expect(chosen?.label).toBe('想成为宝可梦大师');
    expect(chosen?.source).toBe('commitment');
    const projected = projectWorkObject(chosen!);
    expect(projected.goalText).toBe('想成为宝可梦大师');
    expect(projected.execution).toBe('open_question');
    expect(projected.goalText).not.toBe(NORTH_STAR_TEXT);

    const tied = parseWorkProposals([{
      id: 'wo-spark',
      kind: 'question',
      label: '皮卡丘的电是从哪里来的',
      op: 'explore',
      relatesTo: ['g-poke'],
      interestingness: 0.98,
      novelty: 0.3,
      valueToMissions: 0.9,
      cost: 0.12,
      risk: 0.1,
    }], (hint) => hint, seeded).accepted[0]!;
    const hotter = selectWorkPoint([...seeded, ...proposals, tied], 0.9, true);
    expect(hotter?.id).toBe('wo-spark');
    expect(projectWorkObject(hotter!).goalText).toBe('皮卡丘的电是从哪里来的');
    expect(projectWorkObject(hotter!).execution).toBe('open_question');
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

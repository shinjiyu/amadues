import { describe, expect, it } from 'vitest';

import { decide, parseCandidates } from './decide.js';
import { createInitialState } from './state-store.js';
import {
  ABSTRACT_TYPES,
  PROJECTION,
  lifeGoalGraph,
  mergeGoalGraph,
  orientDims,
  projectDecision,
} from './space.js';
import { createTestDataRoot } from '../../testing/temp-data-root.js';
import type { ScoreDims, SubjectDrives } from './types.js';

const drives: SubjectDrives = { curiosity: 0.2, social: 0.4, completion: 0.8 };

describe('subject decision space', () => {
  it('keeps candidates as abstract types before they are projected', () => {
    const rows = parseCandidates(JSON.stringify({
      candidates: [
        { type: 'express', args: { message: '收到' }, rationale: '先表达' },
        { type: 'self_work', args: { goal: '看看仓库', expected_outcome: '一条笔记', type: 'ad-hoc' } },
        { type: 'observe', args: {} },
      ],
    }));
    expect(rows.map((row) => row.type)).toEqual(['express', 'self_work', 'observe']);
    expect(rows.map((row) => row.action)).toEqual(['reply_to_thread', 'propose_self_work', 'do_nothing']);
    expect(rows[0]?.args.text).toBe('收到');
    expect(rows[1]?.args).toMatchObject({
      goalText: '看看仓库',
      expectedOutcome: '一条笔记',
      kind: 'ad_hoc',
      drive: 'curiosity',
    });
  });

  it('applies multi-dim scores and lets code pick the point', () => {
    const aligned: ScoreDims = {
      alignment: 0.9,
      novelty: 0.4,
      cost: 0.1,
      risk: 0.1,
      socialPressure: 0.2,
      completionPressure: 0.8,
    };
    const noisy: ScoreDims = {
      alignment: 0.2,
      novelty: 0.9,
      cost: 0.9,
      risk: 0.8,
      socialPressure: 0.9,
      completionPressure: 0.1,
    };
    const chosen = decide({
      candidates: [
        { type: 'self_work', action: 'self_work', args: { drive: 'completion', kind: 'ad_hoc', goalText: '收尾', expectedOutcome: '一条核对' } },
        { type: 'express', action: 'express', args: { text: '先说一句' } },
      ],
      scores: [
        { action: 'self_work', score: 0, dims: aligned },
        { action: 'express', score: 1, dims: noisy },
      ],
      drives,
    });
    const alignedPoint = orientDims(aligned, 0);
    const noisyPoint = orientDims(noisy, 1);
    expect(alignedPoint).toBeGreaterThan(noisyPoint);
    expect(chosen.chosen?.type).toBe('self_work');
    expect(chosen.chosen?.action).toBe('propose_self_work');
    expect(chosen.total).toBeCloseTo(alignedPoint + 0.3 * drives.completion);
    expect(chosen.reason).toBe('最高分');
  });

  it('projects every abstract type deterministically and only onto the whitelist', () => {
    for (const type of ABSTRACT_TYPES) {
      expect(projectDecision(type)).toEqual({ type, action: PROJECTION[type] });
      expect(projectDecision(type)).toEqual(projectDecision(` ${type} `));
    }
    expect(projectDecision('reply_to_thread')).toEqual({ type: 'express', action: 'reply_to_thread' });
    expect(projectDecision('propose_self_work')).toEqual({ type: 'self_work', action: 'propose_self_work' });
    expect(new Set(Object.values(PROJECTION))).toEqual(new Set([
      'do_nothing',
      'wait',
      'defer',
      'no_reply',
      'reply_to_thread',
      'propose_self_work',
      'schedule_revisit',
      'decline',
    ]));
  });

  it('rejects tool names that are outside the projection', () => {
    const rows = parseCandidates(JSON.stringify({
      candidates: [
        { type: 'delete_memory', args: { goal: '全部删掉' } },
        { action: 'set_goal', args: { goalText: '偷开工' } },
        { action: 'shell', args: { command: 'rm -rf' } },
        { action: 'reply', args: { message: '不该落地' } },
        { type: 'express', args: { text: '合法表达' } },
      ],
    }));
    expect(rows.find((row) => row.action === 'delete_memory')?.args.goalText).toBeUndefined();
    const chosen = decide({
      candidates: rows,
      scores: [
        { action: 'delete_memory', score: 1 },
        { action: 'set_goal', score: 1 },
        { action: 'shell', score: 1 },
        { action: 'reply', score: 1 },
        { action: 'express', score: 0.4 },
      ],
      drives,
    });
    expect(chosen.chosen?.action).toBe('reply_to_thread');
    expect(chosen.chosen?.type).toBe('express');
    expect(chosen.rejected.map((row) => row.action).sort()).toEqual(['delete_memory', 'reply', 'set_goal', 'shell']);
    expect(chosen.rejected.every((row) => row.why === '不在行动白名单内')).toBe(true);
  });

  it('seeds a layered goal graph and keeps relations when an outer goal is added', () => {
    const root = createTestDataRoot('subject-goals-');
    const seeded = createInitialState(root.dataRoot, Date.parse('2026-10-12T00:00:00.000Z'));
    const layers = seeded.goals.map((goal) => goal.layer);
    expect(layers).toEqual([
      'identity',
      'north_star',
      'mission',
      'commitment',
      'constraint',
      'constraint',
      'success_signal',
    ]);
    const mission = seeded.goals.find((goal) => goal.id === 'g-mission');
    expect(mission?.relation).toBe('serves');
    expect(mission?.relatesTo).toEqual(['g-commit', 'g-constraint-signal']);
    const merged = mergeGoalGraph([
      ...lifeGoalGraph(),
      { id: 'g-outer', text: '把夜行的小说写完', keywords: ['小说'], priority: 0.8 },
    ]);
    const outer = merged.find((goal) => goal.id === 'g-outer');
    expect(outer?.layer).toBe('mission');
    expect(outer?.relatesTo).toEqual(['g-north']);
    expect(outer?.relation).toBe('serves');
    expect(merged.some((goal) => goal.id === 'g-constraint-signal')).toBe(true);
    root.cleanup();
  });
});

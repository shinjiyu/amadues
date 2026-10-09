import { describe, expect, it } from 'vitest';

import { parseConstitution } from './constitution.js';
import {
  proposeDriveSeeds,
  extractDriveGoalSlug,
  selectGiveUps,
  DRIVE_GOAL_CREATED_BY,
} from './drive-engine.js';

const RAW = `# 宪章

## 长期目标
- [body] 把 ESP32 运行时做成自己的身体
- [probe|delivery] 摸清一块板子的引脚
- 这行不是目标
- [body] 重复 slug 应忽略

## 放弃条款
同一路线连续多轮无新产出就放弃，换方向，不要空转重试。
`;

describe('parseConstitution', () => {
  it('reads goals and abandonment, drops malformed lines and duplicate slugs', () => {
    const c = parseConstitution(RAW);
    expect(c.goals).toEqual([
      { slug: 'body', objective: '把 ESP32 运行时做成自己的身体', kind: 'ongoing' },
      { slug: 'probe', objective: '摸清一块板子的引脚', kind: 'delivery' },
    ]);
    expect(c.abandonmentClause).toContain('换方向');
  });
});

describe('proposeDriveSeeds', () => {
  const constitution = parseConstitution(RAW);

  it('seeds the first unseeded goal only, and marks provenance', () => {
    const seeds = proposeDriveSeeds({ constitution, existingKpis: [] });
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({
      description: '把 ESP32 运行时做成自己的身体',
      createdBy: DRIVE_GOAL_CREATED_BY,
      kind: 'ongoing',
    });
    expect(extractDriveGoalSlug({ notes: seeds[0]!.notes })).toBe('body');
    expect(seeds[0]!.notes).toContain('放弃条款');
  });

  it('does not reseed a slug that exists in any status', () => {
    const seeds = proposeDriveSeeds({
      constitution,
      existingKpis: [{ notes: 'drive-goal:body\n已放弃' }],
    });
    expect(seeds).toHaveLength(1);
    expect(seeds[0]!.description).toBe('摸清一块板子的引脚');
    expect(seeds[0]!.kind).toBe('delivery');
  });

  it('seeds nothing when every goal is already present', () => {
    const seeds = proposeDriveSeeds({
      constitution,
      existingKpis: [{ notes: 'drive-goal:body' }, { notes: 'drive-goal:probe' }],
    });
    expect(seeds).toEqual([]);
  });
});

describe('selectGiveUps (放弃条款)', () => {
  const row = (over: Partial<Parameters<typeof selectGiveUps>[0][number]>) => ({
    kpiId: 'k',
    status: 'active' as const,
    notes: 'drive-goal:body',
    consecutiveIdleBursts: 0,
    ...over,
  });

  it('abandons a drive-goal KPI that idled past the threshold', () => {
    const out = selectGiveUps([row({ kpiId: 'k1', consecutiveIdleBursts: 3 })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.kpiId).toBe('k1');
    expect(out[0]!.slug).toBe('body');
  });

  it('leaves KPIs below threshold, non-active, or without a drive-goal marker alone', () => {
    const out = selectGiveUps([
      row({ kpiId: 'below', consecutiveIdleBursts: 2 }),
      row({ kpiId: 'paused', status: 'paused', consecutiveIdleBursts: 9 }),
      row({ kpiId: 'human', notes: '人类下达', consecutiveIdleBursts: 9 }),
    ]);
    expect(out).toEqual([]);
  });
});

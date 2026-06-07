import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { KpiRegistry } from '../kpi-registry.js';
import { decomposeParentKpiIfNeeded, planSubKpisFromParent } from './sub-kpi-decomposer.js';

describe('sub-kpi-decomposer', () => {
  let tmp = '';

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('采集+汇报 → 两个子 KPI', () => {
    const parent = {
      kpiId: 'p',
      description: '台湾六维情报持续采集并每日中午晚上汇报',
      kind: 'ongoing' as const,
      notes: '',
      createdBy: 'u',
      createdAt: '',
      status: 'active' as const,
      momentum: 0,
      bursts: [],
      consecutiveIdleBursts: 0,
      reflexionTrail: [],
      isLeaf: false,
      children: [],
      cadence: { type: 'continuous' as const, minGapMs: 1 },
      burstRunHistory: [],
    };
    const specs = planSubKpisFromParent(parent);
    expect(specs.length).toBe(2);
    expect(specs[0]?.cadence.type).toBe('interval');
    expect(specs[1]?.cadence.type).toBe('cron');
  });

  it('decomposeParentKpiIfNeeded 写入 registry', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'decompose-'));
    const reg = new KpiRegistry(tmp);
    const parent = reg.create({
      description: '持续采集并每日汇报简报',
      createdBy: 'u',
      kind: 'ongoing',
      asParent: true,
    });
    const ids = decomposeParentKpiIfNeeded(reg, parent.kpiId);
    expect(ids.length).toBe(2);
    expect(reg.get(parent.kpiId)?.children?.length).toBe(2);
    expect(reg.get(ids[0]!)?.isLeaf).toBe(true);
  });
});

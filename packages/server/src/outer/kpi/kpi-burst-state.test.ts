import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { InnerBrainRegistry } from '../inner-brain-registry.js';
import type { KpiRecord } from '../kpi-registry.js';
import { evaluateKpiAdvanceEligibility } from './kpi-burst-state.js';

describe('kpi-burst-state', () => {
  let tmp = '';

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  function mkKpi(bursts: string[]): { kpi: KpiRecord; registry: InnerBrainRegistry } {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kpi-burst-'));
    const registry = new InnerBrainRegistry(tmp);
    const kpi: KpiRecord = {
      kpiId: 'kpi-1',
      description: 'test',
      createdBy: 'u',
      createdAt: new Date().toISOString(),
      status: 'active',
      kind: 'ongoing',
      momentum: 0,
      bursts,
      consecutiveIdleBursts: 0,
      isLeaf: true,
      cadence: { type: 'continuous', minGapMs: 0 },
      lastBurstAt: new Date(Date.now() - 60_000).toISOString(),
      burstRunHistory: [],
    };
    return { kpi, registry };
  }

  it('running 达 maxParallelPerKpi → kpi_parallel_cap', () => {
    const { kpi, registry } = mkKpi(['ib-a', 'ib-b']);
    for (const id of ['ib-a', 'ib-b']) {
      const workDir = path.join(tmp, id);
      fs.mkdirSync(path.join(workDir, '.brain'), { recursive: true });
      registry.register({
        instanceId: id,
        workspaceId: `task-${id}`,
        workDir,
        goal: 'g',
        originUser: 'u',
        status: 'RUNNING',
        startedAt: new Date().toISOString(),
        kpiId: 'kpi-1',
      });
    }
    const r = evaluateKpiAdvanceEligibility(kpi, registry, { maxParallelPerKpi: 2 });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('kpi_parallel_cap');
  });

  it('default maxParallelPerKpi=1 blocks second running burst', () => {
    const { kpi, registry } = mkKpi(['ib-a']);
    const workDir = path.join(tmp, 'ib-a');
    fs.mkdirSync(path.join(workDir, '.brain'), { recursive: true });
    registry.register({
      instanceId: 'ib-a',
      workspaceId: 'task-ib-a',
      workDir,
      goal: 'g',
      originUser: 'u',
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
      kpiId: 'kpi-1',
    });
    const r = evaluateKpiAdvanceEligibility(kpi, registry, {});
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('kpi_parallel_cap');
  });

  it('running=1 且 maxParallelPerKpi=2 → parallel', () => {
    const { kpi, registry } = mkKpi(['ib-a']);
    const workDir = path.join(tmp, 'ib-a');
    fs.mkdirSync(path.join(workDir, '.brain'), { recursive: true });
    registry.register({
      instanceId: 'ib-a',
      workspaceId: 'task-ib-a',
      workDir,
      goal: 'g',
      originUser: 'u',
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
      kpiId: 'kpi-1',
    });
    const r = evaluateKpiAdvanceEligibility(kpi, registry, { maxParallelPerKpi: 2 });
    expect(r.eligible).toBe(true);
    expect(r.mode).toBe('parallel');
  });
});

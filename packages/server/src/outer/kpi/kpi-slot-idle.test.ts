import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { addPending } from '../../openkuroneko/pendings/index.js';
import { InnerBrainRegistry } from '../inner-brain-registry.js';
import type { KpiRecord } from '../kpi-registry.js';
import { evaluateKpiSlotIdle } from './kpi-slot-idle.js';

describe('kpi-slot-idle', () => {
  let tmp = '';

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  function setup() {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-idle-'));
    tmp = dataRoot;
    const registry = new InnerBrainRegistry(dataRoot);
    const kpi: KpiRecord = {
      kpiId: 'kpi-leaf',
      description: 'ongoing',
      createdBy: 'u',
      createdAt: new Date().toISOString(),
      status: 'active',
      kind: 'ongoing',
      momentum: 0,
      bursts: ['ib-1'],
      consecutiveIdleBursts: 0,
      isLeaf: true,
      cadence: { type: 'continuous', minGapMs: 0 },
      burstRunHistory: [],
    };
    return { registry, kpi, dataRoot };
  }

  it('ongoing DONE → idle（可续派）', () => {
    const { registry, kpi, dataRoot } = setup();
    const workDir = path.join(dataRoot, 'workspaces', 'task-ib-1');
    fs.mkdirSync(path.join(workDir, '.brain'), { recursive: true });
    registry.register({
      instanceId: 'ib-1',
      workspaceId: 'task-ib-1',
      workDir,
      goal: 'g',
      originUser: 'u',
      status: 'DONE',
      startedAt: new Date().toISOString(),
      kpiId: 'kpi-leaf',
    });
    const r = evaluateKpiSlotIdle(kpi, registry);
    expect(r.idle).toBe(true);
  });

  it('ongoing AWAITING timer（无 ask_user）→ idle', () => {
    const { registry, kpi, dataRoot } = setup();
    const workDir = path.join(dataRoot, 'workspaces', 'task-ib-1');
    const brainDir = path.join(workDir, '.brain');
    fs.mkdirSync(brainDir, { recursive: true });
    addPending(brainDir, {
      kind: 'timer',
      spec: { execute_at: '2099-01-01T00:00:00.000Z' },
      source: 'tool:wait_timer',
    });
    fs.writeFileSync(
      path.join(brainDir, 'controller-state.json'),
      JSON.stringify({ mode: 'AWAITING' }),
      'utf8',
    );
    registry.register({
      instanceId: 'ib-1',
      workspaceId: 'task-ib-1',
      workDir,
      goal: 'g',
      originUser: 'u',
      status: 'AWAITING',
      startedAt: new Date().toISOString(),
      kpiId: 'kpi-leaf',
    });
    const r = evaluateKpiSlotIdle(kpi, registry);
    expect(r.idle).toBe(true);
  });

  it('ongoing AWAITING ask_user → 占槽', () => {
    const { registry, kpi, dataRoot } = setup();
    const workDir = path.join(dataRoot, 'workspaces', 'task-ib-1');
    const brainDir = path.join(workDir, '.brain');
    fs.mkdirSync(brainDir, { recursive: true });
    addPending(brainDir, {
      kind: 'ask_user',
      spec: { prompt: '需要凭证' },
      source: 'tool',
    });
    registry.register({
      instanceId: 'ib-1',
      workspaceId: 'task-ib-1',
      workDir,
      goal: 'g',
      originUser: 'u',
      status: 'AWAITING',
      startedAt: new Date().toISOString(),
      kpiId: 'kpi-leaf',
    });
    const r = evaluateKpiSlotIdle(kpi, registry);
    expect(r.idle).toBe(false);
    expect(r.reason).toBe('awaiting_human');
  });
});

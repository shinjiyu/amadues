import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  evaluateKpiAutonomyDispatch,
  findLiveBurstForKpi,
} from './kpi-dispatch-guard.js';
import { evaluateKpiAdvanceEligibility } from './kpi/kpi-burst-state.js';
import { KpiRegistry } from './kpi-registry.js';
import { InnerBrainRegistry } from './inner-brain-registry.js';
import type { TaskRecord } from './inner-brain-registry.js';
import { createTestDataRoot, type TestDataRoot } from '../testing/temp-data-root.js';
import { addPending } from '../openkuroneko/pendings/index.js';

describe('evaluateKpiAutonomyDispatch', () => {
  let root: TestDataRoot;
  let kpiRegistry: KpiRegistry;
  let innerBrainRegistry: InnerBrainRegistry;

  afterEach(() => {
    root?.cleanup();
  });

  function setup() {
    root = createTestDataRoot('kpi-dispatch-guard-');
    kpiRegistry = new KpiRegistry(root.dataRoot);
    innerBrainRegistry = new InnerBrainRegistry(root.dataRoot);
  }

  function registerBurst(
    rec: Partial<TaskRecord> & Pick<TaskRecord, 'instanceId' | 'kpiId' | 'status'>,
  ) {
    innerBrainRegistry.register({
      workspaceId: `task-${rec.instanceId}`,
      workDir: `${root.workspacesDir}/task-${rec.instanceId}`,
      goal: 'test',
      originUser: 'idp:agent:shiro',
      startedAt: new Date().toISOString(),
      ...rec,
    } as TaskRecord);
  }

  it('无 burst 时可派 first_burst', () => {
    setup();
    const kpiId = kpiRegistry.create({
      description: 'test kpi',
      createdBy: 'idp:agent:shiro',
    }).kpiId;
    const d = evaluateKpiAutonomyDispatch(kpiRegistry, innerBrainRegistry, kpiId);
    expect(d.ok).toBe(true);
    expect(d.reason).toBe('first');
  });

  it('findLiveBurstForKpi 可排除 onExit 中的当前实例', () => {
    setup();
    const kpiId = kpiRegistry.create({
      description: 'test kpi',
      createdBy: 'idp:agent:shiro',
    }).kpiId;
    registerBurst({
      instanceId: 'ib-exiting',
      kpiId,
      status: 'RUNNING',
    });
    expect(findLiveBurstForKpi(innerBrainRegistry, kpiId)).toBeDefined();
    expect(findLiveBurstForKpi(innerBrainRegistry, kpiId, 'ib-exiting')).toBeUndefined();
  });

  it('有 RUNNING burst 时仍可在有容量时并行派发', () => {
    setup();
    const kpiId = kpiRegistry.create({
      description: 'test kpi',
      createdBy: 'idp:agent:shiro',
      kind: 'ongoing',
    }).kpiId;
    kpiRegistry.attachBurst(kpiId, 'ib-live');
    kpiRegistry.update(kpiId, {
      lastBurstAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      cadence: { type: 'continuous', minGapMs: 0 },
    });
    registerBurst({
      instanceId: 'ib-live',
      kpiId,
      status: 'RUNNING',
    });
    const kpi = kpiRegistry.get(kpiId)!;
    const elig = evaluateKpiAdvanceEligibility(kpi, innerBrainRegistry, {
      allowParallel: true,
      hasSystemCapacity: true,
      maxParallelPerKpi: 2,
    });
    expect(elig.eligible).toBe(true);
    expect(elig.mode).toBe('parallel');

    const d = evaluateKpiAutonomyDispatch(kpiRegistry, innerBrainRegistry, kpiId, {
      hasSystemCapacity: true,
      maxParallelPerKpi: 2,
    });
    expect(d.ok).toBe(true);
    expect(d.reason).toBe('parallel');
  });

  it('有 RUNNING burst 且无系统容量时拒绝', () => {
    setup();
    const kpiId = kpiRegistry.create({
      description: 'test kpi',
      createdBy: 'idp:agent:shiro',
      kind: 'ongoing',
    }).kpiId;
    kpiRegistry.attachBurst(kpiId, 'ib-live');
    kpiRegistry.update(kpiId, {
      lastBurstAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      cadence: { type: 'continuous', minGapMs: 0 },
    });
    registerBurst({
      instanceId: 'ib-live',
      kpiId,
      status: 'RUNNING',
    });
    const d = evaluateKpiAutonomyDispatch(kpiRegistry, innerBrainRegistry, kpiId, {
      hasSystemCapacity: false,
      maxParallelPerKpi: 2,
    });
    expect(d.ok).toBe(false);
    expect(d.reason).toBe('kpi_burst_in_flight');
  });

  it('有 AWAITING ask_user 时拒绝', () => {
    setup();
    const kpiId = kpiRegistry.create({
      description: 'test kpi',
      createdBy: 'idp:agent:shiro',
    }).kpiId;
    kpiRegistry.attachBurst(kpiId, 'ib-await');
    const workDir = `${root.workspacesDir}/task-ib-await`;
    const brainDir = `${workDir}/.brain`;
    registerBurst({
      instanceId: 'ib-await',
      kpiId,
      status: 'AWAITING',
      workDir,
      workspaceId: 'task-ib-await',
    });
    fs.mkdirSync(brainDir, { recursive: true });
    addPending(brainDir, {
      kind: 'ask_user',
      spec: { prompt: 'q' },
      source: 'tool',
    });
    const d = evaluateKpiAutonomyDispatch(kpiRegistry, innerBrainRegistry, kpiId);
    expect(d.ok).toBe(false);
    expect(d.reason).toBe('awaiting_human');
  });

  it('ERROR 后 ongoing 无 RUNNING 时允许续派', () => {
    setup();
    const kpiId = kpiRegistry.create({
      description: 'test kpi',
      createdBy: 'idp:agent:shiro',
      kind: 'ongoing',
    }).kpiId;
    kpiRegistry.update(kpiId, {
      lastBurstAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      cadence: { type: 'continuous', minGapMs: 0 },
    });
    const k = kpiRegistry.get(kpiId)!;
    k.bursts.push('ib-done');
    kpiRegistry.update(kpiId, { bursts: k.bursts });
    registerBurst({
      instanceId: 'ib-done',
      kpiId,
      status: 'ERROR',
      deliverableCount: 2,
      finishedAt: new Date().toISOString(),
    });
    const d = evaluateKpiAutonomyDispatch(kpiRegistry, innerBrainRegistry, kpiId);
    expect(d.ok).toBe(true);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { evaluateKpiAutonomyDispatch } from './kpi-dispatch-guard.js';
import { KpiRegistry } from './kpi-registry.js';
import { InnerBrainRegistry } from './inner-brain-registry.js';
import type { TaskRecord } from './inner-brain-registry.js';
import { createTestDataRoot, type TestDataRoot } from '../testing/temp-data-root.js';

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
    expect(d.reason).toBe('first_burst');
  });

  it('有 RUNNING burst 时仍允许并行派发（容量由 canSpawnInner 把关）', () => {
    setup();
    const kpiId = kpiRegistry.create({
      description: 'test kpi',
      createdBy: 'idp:agent:shiro',
    }).kpiId;
    kpiRegistry.attachBurst(kpiId, 'ib-live');
    registerBurst({
      instanceId: 'ib-live',
      kpiId,
      status: 'RUNNING',
    });
    const d = evaluateKpiAutonomyDispatch(kpiRegistry, innerBrainRegistry, kpiId);
    expect(d.ok).toBe(true);
    expect(d.reason).toBe('parallel_next_burst');
    expect(d.liveInstanceId).toBe('ib-live');
  });

  it('有 AWAITING burst 时仍允许并行派发不重复任务', () => {
    setup();
    const kpiId = kpiRegistry.create({
      description: 'test kpi',
      createdBy: 'idp:agent:shiro',
    }).kpiId;
    kpiRegistry.attachBurst(kpiId, 'ib-await');
    registerBurst({
      instanceId: 'ib-await',
      kpiId,
      status: 'AWAITING',
    });
    const d = evaluateKpiAutonomyDispatch(kpiRegistry, innerBrainRegistry, kpiId);
    expect(d.ok).toBe(true);
    expect(d.reason).toBe('parallel_next_burst');
  });

  it('ERROR 后有 deliverable、idle streak=1 时允许续派', () => {
    setup();
    const kpiId = kpiRegistry.create({
      description: 'test kpi',
      createdBy: 'idp:agent:shiro',
    }).kpiId;
    kpiRegistry.attachBurst(kpiId, 'ib-done');
    kpiRegistry.recordIdle(kpiId);
    registerBurst({
      instanceId: 'ib-done',
      kpiId,
      status: 'ERROR',
      deliverableCount: 2,
      finishedAt: new Date().toISOString(),
    });
    const d = evaluateKpiAutonomyDispatch(kpiRegistry, innerBrainRegistry, kpiId);
    expect(d.ok).toBe(true);
    expect(d.reason).toMatch(/next_burst|ok/);
  });

  it('idle streak 达阈值时拒绝并走反思路径', () => {
    setup();
    const kpiId = kpiRegistry.create({
      description: 'test kpi',
      createdBy: 'idp:agent:shiro',
    }).kpiId;
    kpiRegistry.attachBurst(kpiId, 'ib-idle-3');
    kpiRegistry.recordIdle(kpiId);
    kpiRegistry.recordIdle(kpiId);
    kpiRegistry.recordIdle(kpiId);
    registerBurst({
      instanceId: 'ib-idle-3',
      kpiId,
      status: 'ERROR',
      deliverableCount: 0,
      finishedAt: new Date().toISOString(),
    });
    const d = evaluateKpiAutonomyDispatch(kpiRegistry, innerBrainRegistry, kpiId);
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/kpi_stuck_reflexion/);
  });
});

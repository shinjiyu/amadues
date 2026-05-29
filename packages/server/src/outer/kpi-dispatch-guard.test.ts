import { describe, expect, it } from 'vitest';

import { createTestDataRoot } from '../testing/temp-data-root.js';
import { InnerBrainRegistry } from './inner-brain-registry.js';
import { KpiRegistry } from './kpi-registry.js';
import {
  evaluateKpiAutonomyDispatch,
  findLiveBurstForKpi,
  hasLiveWorkForKpi,
} from './kpi-dispatch-guard.js';

describe('kpi-dispatch-guard', () => {
  it('detects live burst for KPI', () => {
    const root = createTestDataRoot('kpi-guard-');
    const registry = new InnerBrainRegistry(root.dataRoot);
    const kpiRegistry = new KpiRegistry(root.dataRoot);
    const kpi = kpiRegistry.create({ description: '测试 KPI', createdBy: 'test' });

    registry.register({
      instanceId: 'ib-live-0001',
      workspaceId: 'task-ib-live-0001',
      workDir: `${root.dataRoot}/workspaces/task-ib-live-0001`,
      goal: '正在跑',
      originUser: 'test',
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
      kpiId: kpi.kpiId,
    });

    expect(hasLiveWorkForKpi(registry, kpi.kpiId)).toBe(true);
    expect(findLiveBurstForKpi(registry, kpi.kpiId)?.instanceId).toBe('ib-live-0001');

    const decision = evaluateKpiAutonomyDispatch(kpiRegistry, registry, kpi.kpiId);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe('kpi_burst_in_progress');

    root.cleanup();
  });

  it('allows dispatch when latest burst is terminal', () => {
    const root = createTestDataRoot('kpi-guard-done-');
    const registry = new InnerBrainRegistry(root.dataRoot);
    const kpiRegistry = new KpiRegistry(root.dataRoot);
    const kpi = kpiRegistry.create({ description: '测试 KPI', createdBy: 'test' });
    kpiRegistry.attachBurst(kpi.kpiId, 'ib-done-0001');

    registry.register({
      instanceId: 'ib-done-0001',
      workspaceId: 'task-ib-done-0001',
      workDir: `${root.dataRoot}/workspaces/task-ib-done-0001`,
      goal: '已完成',
      originUser: 'test',
      status: 'DONE',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      kpiId: kpi.kpiId,
    });

    expect(hasLiveWorkForKpi(registry, kpi.kpiId)).toBe(false);
    const decision = evaluateKpiAutonomyDispatch(kpiRegistry, registry, kpi.kpiId);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toContain('kpi_continue');

    root.cleanup();
  });
});

import { afterEach, describe, expect, it } from 'vitest';

import { InnerBrainRegistry } from './inner-brain-registry.js';
import { KpiRegistry } from './kpi-registry.js';
import {
  buildKpiContinuationGoal,
  findCanonicalBurstForKpi,
  isSetGoalDispatched,
} from './inner-brain-kpi-reuse.js';
import { createTestDataRoot, type TestDataRoot } from '../testing/temp-data-root.js';

describe('inner-brain-kpi-reuse', () => {
  let root: TestDataRoot;
  let kpiRegistry: KpiRegistry;
  let innerBrainRegistry: InnerBrainRegistry;

  afterEach(() => {
    root?.cleanup();
  });

  function setup() {
    root = createTestDataRoot('ib-kpi-reuse-');
    kpiRegistry = new KpiRegistry(root.dataRoot);
    innerBrainRegistry = new InnerBrainRegistry(root.dataRoot);
  }

  it('findCanonicalBurstForKpi 优先首个非 meta burst', () => {
    setup();
    const kpiId = kpiRegistry.create({ description: 'kpi', createdBy: 'u' }).kpiId;
    kpiRegistry.attachBurst(kpiId, 'ib-meta');
    kpiRegistry.attachBurst(kpiId, 'ib-main');
    innerBrainRegistry.register({
      instanceId: 'ib-meta',
      workspaceId: 'task-ib-meta',
      workDir: `${root.workspacesDir}/task-ib-meta`,
      goal: 'meta',
      originUser: 'u',
      startedAt: new Date().toISOString(),
      status: 'DONE',
      kpiId,
      isReflexionBurst: true,
    });
    innerBrainRegistry.register({
      instanceId: 'ib-main',
      workspaceId: 'task-ib-main',
      workDir: `${root.workspacesDir}/task-ib-main`,
      goal: 'main',
      originUser: 'u',
      startedAt: new Date().toISOString(),
      status: 'DONE',
      kpiId,
    });
    expect(findCanonicalBurstForKpi(innerBrainRegistry, kpiRegistry, kpiId)?.instanceId).toBe(
      'ib-main',
    );
  });

  it('buildKpiContinuationGoal 含续跑约束', () => {
    setup();
    const kpi = kpiRegistry.create({ description: '对战 KPI', createdBy: 'u' });
    const text = buildKpiContinuationGoal(kpi);
    expect(text).toContain('同一内脑实例');
    expect(text).toContain('一小步');
  });

  it('isSetGoalDispatched 识别新建与续跑', () => {
    expect(isSetGoalDispatched('已创建新内脑实例并启动任务。instance_id=ib-1')).toBe(true);
    expect(isSetGoalDispatched('已在既有内脑实例上续跑。instance_id=ib-1')).toBe(true);
    expect(isSetGoalDispatched('（同 KPI 在途 burst')).toBe(false);
  });
});

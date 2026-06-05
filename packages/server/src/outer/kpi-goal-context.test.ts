import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { createTestDataRoot } from '../testing/temp-data-root.js';
import { InnerBrainRegistry } from './inner-brain-registry.js';
import { KpiRegistry } from './kpi-registry.js';
import { buildKpiGoalPlannerContext } from './kpi-goal-context.js';
import type { ResourceSnapshot } from './autonomy-types.js';

function baseSnapshot(): ResourceSnapshot {
  return {
    capturedAt: new Date().toISOString(),
    agentId: 'agent-test',
    innerBrains: { running: 1, awaiting: 0, blocked: 0, asyncWaiting: 0 },
    llm: { inFlight: 0, tokensLast1h: { prompt: 0, completion: 0, total: 0 }, callsLast1h: 0 },
    inbound: { orchestratorQueuedTotal: 0, outerLoopActiveThreads: 0 },
    im: { lastProactiveSpeakAt: null, proactiveCount5min: 0 },
    process: { heapUsedMb: 100, rssMb: 200 },
  };
}

describe('buildKpiGoalPlannerContext', () => {
  it('includes KPI digest, burst details, live brains, and constraints', async () => {
    const root = createTestDataRoot('kpi-ctx-');
    const registry = new InnerBrainRegistry(root.dataRoot);
    const kpiRegistry = new KpiRegistry(root.dataRoot);
    const kpi = kpiRegistry.create({
      description: '测试 KPI：竞品调研',
      createdBy: 'test',
      notes: '优先国内平台',
    });

    const workDir = path.join(root.dataRoot, 'workspaces', 'task-ib-done-0001');
    fs.mkdirSync(path.join(workDir, '.brain'), { recursive: true });
    fs.writeFileSync(path.join(workDir, '.brain', 'goal.md'), '已完成 burst 的 goal', 'utf8');
    fs.writeFileSync(
      path.join(workDir, '.brain', 'milestones.md'),
      '[M1] [Completed] 调研完成',
      'utf8',
    );
    fs.mkdirSync(path.join(workDir, '.run', 'pi-mono'), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, '.run', 'pi-mono', 'deliverables.json'),
      JSON.stringify(['report.md']),
      'utf8',
    );

    registry.register({
      instanceId: 'ib-done-0001',
      workspaceId: 'task-ib-done-0001',
      workDir,
      goal: '已完成 burst 的 goal',
      originUser: 'test',
      status: 'DONE',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      kpiId: kpi.kpiId,
      deliverableCount: 1,
    });
    kpiRegistry.attachBurst(kpi.kpiId, 'ib-done-0001');

    const liveDir = path.join(root.dataRoot, 'workspaces', 'task-ib-live-0002');
    fs.mkdirSync(liveDir, { recursive: true });
    registry.register({
      instanceId: 'ib-live-0002',
      workspaceId: 'task-ib-live-0002',
      workDir: liveDir,
      goal: '正在跑的 burst goal',
      originUser: 'test',
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
      kpiId: kpi.kpiId,
      ticks: 2,
    });

    const ctx = await buildKpiGoalPlannerContext({
      dataRoot: root.dataRoot,
      kpi: kpiRegistry.get(kpi.kpiId)!,
      kpiRegistry,
      registry,
      snapshot: baseSnapshot(),
    });

    expect(ctx).toContain('测试 KPI：竞品调研');
    expect(ctx).toContain('ib-done-0001');
    expect(ctx).toContain('report.md');
    expect(ctx).toContain('ib-live-0002');
    expect(ctx).toContain('本 KPI 在途内脑');
    expect(ctx).toContain('规划约束');
    expect(ctx).toContain('consecutive_idle_bursts');
    expect(ctx).toContain('优先国内平台');

    root.cleanup();
  });

  it('excludes non-KPI live inner brains from planner context', async () => {
    const root = createTestDataRoot('kpi-ctx-filter-');
    const registry = new InnerBrainRegistry(root.dataRoot);
    const kpiRegistry = new KpiRegistry(root.dataRoot);
    const kpi = kpiRegistry.create({ description: '主 KPI', createdBy: 'test' });

    const otherDir = path.join(root.dataRoot, 'workspaces', 'task-ib-other-99');
    fs.mkdirSync(otherDir, { recursive: true });
    registry.register({
      instanceId: 'ib-other-99',
      workspaceId: 'task-ib-other-99',
      workDir: otherDir,
      goal: '一次性杂务：帮别人传文件',
      originUser: 'test',
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
    });

    const ctx = await buildKpiGoalPlannerContext({
      dataRoot: root.dataRoot,
      kpi: kpiRegistry.get(kpi.kpiId)!,
      kpiRegistry,
      registry,
      snapshot: baseSnapshot(),
    });

    expect(ctx).not.toContain('ib-other-99');
    expect(ctx).not.toContain('帮别人传文件');
    expect(ctx).toContain('非本 KPI');

    root.cleanup();
  });
});

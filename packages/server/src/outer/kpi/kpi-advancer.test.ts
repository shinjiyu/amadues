import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KpiRegistry } from '../kpi-registry.js';
import { InnerBrainRegistry } from '../inner-brain-registry.js';
import { tickKpiAdvancer, type KpiAdvancerDeps } from './kpi-advancer.js';
import * as outerTools from '../outer-tools.js';

describe('kpi-advancer', () => {
  let tmp = '';

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  function baseDeps(): KpiAdvancerDeps {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kpi-adv-'));
    const kpiRegistry = new KpiRegistry(tmp);
    const innerBrainRegistry = new InnerBrainRegistry(tmp);
    return {
      kpiRegistry,
      innerBrainRegistry,
      toolCtx: {
        threadId: 'thread-1',
        agentSid: 'agent:test',
        workspaceId: 'default',
        dataRoot: tmp,
        imClient: { postMessage: async () => {} } as never,
        assetStore: {} as never,
        getEngine: () => ({ setGoal() {} }) as never,
        workspaceStore: { ensureWorkspace() {} } as never,
        repoStore: {} as never,
        innerBrainRegistry,
        kpiRegistry,
      },
      workspaceId: 'default',
      defaultThreadId: 'thread-1',
      hasSystemCapacity: true,
      allowParallel: true,
      maxParallelPerKpi: 2,
    };
  }

  it('有 RUNNING burst 且系统有槽 → 并行 dispatch', async () => {
    const deps = baseDeps();
    const kpi = deps.kpiRegistry.create({
      description: '持续任务',
      createdBy: 'u',
      kind: 'ongoing',
    });
    deps.kpiRegistry.attachBurst(kpi.kpiId, 'ib-run');
    deps.kpiRegistry.update(kpi.kpiId, {
      lastBurstAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      cadence: { type: 'continuous', minGapMs: 0 },
    });
    deps.innerBrainRegistry.register({
      instanceId: 'ib-run',
      workspaceId: 'task-ib-run',
      workDir: path.join(tmp, 'workspaces', 'task-ib-run'),
      goal: 'g',
      originUser: 'u',
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
      kpiId: kpi.kpiId,
    });

    vi.spyOn(outerTools, 'executeOuterTool').mockResolvedValue({
      replied: false,
      output: '已创建新内脑实例并启动任务。instance_id=ib-parallel-1',
    });

    const tick = await tickKpiAdvancer(deps);
    expect(tick.advanced).toBe(true);
    expect(tick.results[0]?.reason).toBe('kpi_parallel_sprint');
  });

  it('delivery KPI 首 burst → dispatch sprint', async () => {
    const deps = baseDeps();
    const kpi = deps.kpiRegistry.create({ description: '写 hello', createdBy: 'u' });
    vi.spyOn(outerTools, 'executeOuterTool').mockResolvedValue({
      replied: false,
      output: '已创建新内脑实例并启动任务。instance_id=ib-leaf-1',
    });

    const tick = await tickKpiAdvancer(deps);
    expect(tick.advanced).toBe(true);
    expect(tick.results[0]?.instanceId).toBe('ib-leaf-1');
  });
});

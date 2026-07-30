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

  it('delivery KPI 首 burst → dispatch', async () => {
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

  it('多轮 dispatch 不把渲染 goal 写回 charter（消除 goal.md 嵌套）', async () => {
    const deps = baseDeps();
    const kpi = deps.kpiRegistry.create({
      description: '台湾情报常态收集',
      createdBy: 'u',
      kind: 'ongoing',
    });

    const goals: string[] = [];
    vi.spyOn(outerTools, 'executeOuterTool').mockImplementation(async (_name, argJson) => {
      const parsed = JSON.parse(argJson as string) as { goal: string };
      goals.push(parsed.goal);
      return { replied: false, output: '已创建新内脑实例并启动任务。instance_id=ib-x' };
    });

    await tickKpiAdvancer(deps);
    await tickKpiAdvancer(deps);

    // charter 不应被设为渲染后的 burst goal
    const after = deps.kpiRegistry.get(kpi.kpiId);
    expect(after?.charter).toBeUndefined();

    // 第二轮 goal 里 "# KPI burst" 头只出现一次（无嵌套）
    expect(goals.length).toBe(2);
    const occurrences = goals[1]!.split('# KPI burst').length - 1;
    expect(occurrences).toBe(1);
    expect(goals[1]).toContain('台湾情报常态收集');
  });

  it('KPI 已挂 EW tag → set_goal(burst_mode=execute)', async () => {
    const deps = baseDeps();
    const { ExecutableWorkflowStore } = await import('../executable-workflow-store.js');
    const { promoteWorkflow } = await import('../workflow-promote.js');
    const store = new ExecutableWorkflowStore({ dataRoot: tmp });
    const kpi = deps.kpiRegistry.create({
      description: 'X 采集',
      createdBy: 'u',
      kind: 'ongoing',
    });
    promoteWorkflow(store, {
      id: 'ew-twitter-collect-17-bloggers',
      kind: 'shell_pipeline',
      title: 'X collect',
      tags: [`kpi:${kpi.kpiId}`, 'role:primary'],
      steps: [
        {
          id: 'a',
          action: 'assert',
          args: { touch: 'ok.txt' },
          expect: { fileExists: 'ok.txt' },
        },
      ],
    });
    deps.toolCtx.executableWorkflowStore = store;

    let args: Record<string, unknown> = {};
    vi.spyOn(outerTools, 'executeOuterTool').mockImplementation(async (_name, argJson) => {
      args = JSON.parse(argJson as string) as Record<string, unknown>;
      return {
        replied: false,
        output: '已后台启动工作流 ew-twitter-collect-17-bloggers@5（instance=ib-ew-1，ws=task-ib-ew-1）',
      };
    });

    const tick = await tickKpiAdvancer(deps);
    expect(tick.results[0]?.ok, JSON.stringify(tick.results)).toBe(true);
    expect(tick.advanced).toBe(true);
    expect(tick.results[0]?.reason).toBe('kpi_sprint_dispatched_execute');
    expect(args.burst_mode).toBe('execute');
    expect(args.workflow_id).toBe('ew-twitter-collect-17-bloggers');
    expect(String(args.workflow_version)).toBe('1');
    expect(args.kpi_id).toBe(kpi.kpiId);
  });
});

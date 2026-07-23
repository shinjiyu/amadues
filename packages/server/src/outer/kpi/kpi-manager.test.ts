import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InnerBrainRegistry } from '../inner-brain-registry.js';
import { KpiRegistry } from '../kpi-registry.js';
import { defaultAutonomyPolicy, saveAutonomyPolicy } from '../autonomy-policy-store.js';
import type { EnvironmentSnapshot } from '../environment/environment-types.js';
import { ExecutableWorkflowStore } from '../executable-workflow-store.js';
import { promoteWorkflow } from '../workflow-promote.js';
import { writeBurstModeMarker } from '../../openkuroneko/inner-brain/workflow-runner.js';
import {
  reapStaleBursts,
  tickKpiManager,
  type KpiManagerDeps,
} from './kpi-manager.js';
import * as outerTools from '../outer-tools.js';

function idleEnvironment(innerRunning = 0): EnvironmentSnapshot {
  const at = new Date().toISOString();
  return {
    capturedAt: at,
    agentId: 'agent-test',
    facets: {
      innerBrains: {
        sensorId: 'innerBrains',
        capturedAt: at,
        data: { running: innerRunning, awaiting: 0, blocked: 0, asyncWaiting: 0 },
        derived: {},
      },
      llmUsage: {
        sensorId: 'llmUsage',
        capturedAt: at,
        data: { inFlight: 0, tokensLast1h: { prompt: 0, completion: 0, total: 0 }, callsLast1h: 0 },
        derived: {},
      },
      inbound: {
        sensorId: 'inbound',
        capturedAt: at,
        data: { orchestratorQueuedTotal: 0, outerLoopActiveThreads: 0 },
        derived: {},
      },
    },
  };
}

describe('kpi-manager', () => {
  let tmp = '';

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  function baseDeps(): KpiManagerDeps {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kpi-mgr-'));
    const policy = defaultAutonomyPolicy();
    policy.taskTypes.kpi_inner_goal = { enabled: true };
    saveAutonomyPolicy(tmp, policy);

    const kpiRegistry = new KpiRegistry(tmp);
    const registry = new InnerBrainRegistry(tmp);
    return {
      dataRoot: tmp,
      kpiRegistry,
      registry,
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
        innerBrainRegistry: registry,
        kpiRegistry,
      },
      workspaceId: 'default',
      defaultThreadId: 'thread-1',
    };
  }

  const idleVerdict = { level: 'idle' as const, reasons: ['hard_gates_pass'], judgedAt: new Date().toISOString() };
  const busyVerdict = {
    level: 'busy' as const,
    reasons: ['llm_in_flight'],
    blockedByHardGate: 'llm_in_flight',
    judgedAt: new Date().toISOString(),
  };

  it('reapStaleBursts → 超时 AWAITING 标 ABORTED', async () => {
    const deps = baseDeps();
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    deps.registry.register({
      instanceId: 'ib-stale',
      workspaceId: 'task-ib-stale',
      workDir: path.join(tmp, 'workspaces', 'task-ib-stale'),
      goal: 'g',
      originUser: 'u',
      status: 'AWAITING',
      startedAt: old,
      lastTickAt: old,
    });

    const reaped = await reapStaleBursts(deps);
    expect(reaped.abortedIds).toEqual(['ib-stale']);
    expect(deps.registry.get('ib-stale')?.status).toBe('ABORTED');
  });

  it('busy gate → 不 advance 但仍 reap', async () => {
    const deps = baseDeps();
    const advancerTick = vi.fn().mockResolvedValue({ advanced: false, results: [] });
    deps.advancerTick = advancerTick;

    const result = await tickKpiManager(deps, idleEnvironment(), busyVerdict);
    expect(result.dispatched).toBe(false);
    expect(result.reason).toBe('llm_in_flight');
    expect(advancerTick).not.toHaveBeenCalled();
  });

  it('inner slot 满 → 不 advance', async () => {
    const deps = baseDeps();
    deps.kpiRegistry.create({ description: '写 hello', createdBy: 'u' });
    const policy = defaultAutonomyPolicy();
    policy.hardGates.maxRunningInnerBrains = 1;
    saveAutonomyPolicy(tmp, policy);

    const advancerTick = vi.fn().mockResolvedValue({ advanced: false, results: [] });
    deps.advancerTick = advancerTick;

    const result = await tickKpiManager(deps, idleEnvironment(1), idleVerdict);
    expect(result.dispatched).toBe(false);
    expect(result.reason).toContain('running_inner');
    expect(advancerTick).not.toHaveBeenCalled();
  });

  it('idle + active KPI → advance 成功', async () => {
    const deps = baseDeps();
    deps.kpiRegistry.create({ description: '写 hello', createdBy: 'u' });
    vi.spyOn(outerTools, 'executeOuterTool').mockResolvedValue({
      replied: false,
      output: '已创建新内脑实例并启动任务。instance_id=ib-kpi-1',
    });

    const result = await tickKpiManager(deps, idleEnvironment(), idleVerdict);
    expect(result.dispatched).toBe(true);
    expect(result.instanceId).toBe('ib-kpi-1');
  });

  it('DE-4: 旧 kpi_inner_goal maxPerDay/cooldown 不挡 advance', async () => {
    const deps = baseDeps();
    deps.kpiRegistry.create({ description: '写 hello', createdBy: 'u' });
    const policy = defaultAutonomyPolicy();
    // 故意写回旧配额（save 不走 normalize）；load 在 tick 内会剥掉，且 eligible 也不再读配额
    policy.taskTypes.kpi_inner_goal = { enabled: true, cooldownMs: 7_200_000, maxPerDay: 3 };
    saveAutonomyPolicy(tmp, policy);
    // 直接污染磁盘绕过 normalize 的路径：再写入一次原始 JSON
    fs.writeFileSync(
      path.join(tmp, 'autonomy', 'policy.json'),
      JSON.stringify(
        {
          ...policy,
          hardGates: { ...policy.hardGates, minMsSinceLastAutonomousAction: 900_000 },
          taskTypes: {
            ...policy.taskTypes,
            kpi_inner_goal: { enabled: true, cooldownMs: 7_200_000, maxPerDay: 3 },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    vi.spyOn(outerTools, 'executeOuterTool').mockResolvedValue({
      replied: false,
      output: '已创建新内脑实例并启动任务。instance_id=ib-kpi-2',
    });

    const result = await tickKpiManager(deps, idleEnvironment(), idleVerdict);
    expect(result.dispatched).toBe(true);
    expect(result.reason).not.toMatch(/max_per_day|cooldown/);
  });

  it('tick 触发 workflowFailureCircuit pause EW', async () => {
    const deps = baseDeps();
    const store = new ExecutableWorkflowStore({ dataRoot: tmp });
    deps.executableWorkflowStore = store;
    promoteWorkflow(store, {
      id: 'ew-tick',
      kind: 'shell_pipeline',
      title: 'tick',
      steps: [{ id: 's1', action: 'assert', expect: { fileExists: 'x' } }],
    });

    for (let i = 0; i < 3; i++) {
      const ws = path.join(tmp, 'workspaces', `task-ew-${i}`);
      fs.mkdirSync(path.join(ws, '.brain'), { recursive: true });
      writeBurstModeMarker(ws, {
        burstMode: 'execute',
        workflowRef: { id: 'ew-tick', version: '1' },
      });
      const t = new Date(Date.now() - (3 - i) * 60_000).toISOString();
      deps.registry.register({
        instanceId: `ib-ew-${i}`,
        workspaceId: `task-ew-${i}`,
        workDir: ws,
        goal: `[ew:ew-tick@1] fail ${i}`,
        originUser: 'u',
        status: 'ERROR',
        startedAt: t,
        finishedAt: t,
        errorMessage: `fail-${i}`,
      });
    }

    const result = await tickKpiManager(deps, idleEnvironment(), busyVerdict);
    expect(result.workflowCircuit.paused.some((h) => h.id === 'ew-tick')).toBe(true);
    expect(store.getMeta('ew-tick')?.paused).toBe(true);
  });
});

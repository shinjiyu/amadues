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
    };
  }

  it('strategyMode + focusOrder 无交集 → 不推进', async () => {
    const deps = baseDeps();
    deps.kpiRegistry.create({
      description: '持续采集并每日汇报',
      createdBy: 'u',
      kind: 'ongoing',
      asParent: true,
    });
    const tick = await tickKpiAdvancer({ ...deps, focusOrder: ['ghost'], strategyMode: true });
    expect(tick.advanced).toBe(false);
  });

  it('delivery leaf due → dispatch sprint', async () => {
    const deps = baseDeps();
    const kpi = deps.kpiRegistry.create({ description: '写 hello', createdBy: 'u' });
    vi.spyOn(outerTools, 'executeOuterTool').mockResolvedValue({
      replied: false,
      output: '已在既有内脑实例上续跑 instance_id=ib-leaf-1',
    });

    const tick = await tickKpiAdvancer(deps);
    expect(tick.advanced).toBe(true);
    expect(deps.kpiRegistry.get(kpi.kpiId)?.canonicalInstanceId).toBe('ib-leaf-1');
  });
});

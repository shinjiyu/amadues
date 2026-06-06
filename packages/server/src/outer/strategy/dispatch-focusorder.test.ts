/**
 * dispatcher focusOrder/strategyMode 接线单测：战略层启用时按 focusOrder 派；交集空 → 跳过闲聊。
 * ADL: doc/structurizr/STRATEGY-PLANNING-LAYER.md §8/§10
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dispatchAutonomyTasks, type AutonomyDispatchDeps } from '../autonomy-task-dispatcher.js';
import { InnerBrainRegistry } from '../inner-brain-registry.js';
import { KpiRegistry } from '../kpi-registry.js';
import type { AutonomyVerdict } from '../autonomy-types.js';
import type { OuterToolContext } from '../outer-tools.js';

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kuroneko-disp-'));
});
afterEach(() => {
  if (tmpRoot && fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const idleVerdict: AutonomyVerdict = { level: 'idle', reasons: ['hard_gates_pass'], judgedAt: new Date().toISOString() };

function snapshot() {
  return {
    capturedAt: new Date().toISOString(), agentId: 'a',
    innerBrains: { running: 0, awaiting: 0, blocked: 0, asyncWaiting: 0 },
    llm: { inFlight: 0, tokensLast1h: { prompt: 0, completion: 0, total: 0 }, callsLast1h: 0 },
    inbound: { orchestratorQueuedTotal: 0, outerLoopActiveThreads: 0 },
    im: { lastProactiveSpeakAt: null, proactiveCount5min: 0 },
    process: { heapUsedMb: 1, rssMb: 1 },
  };
}

function deps(kpiRegistry: KpiRegistry, registry: InnerBrainRegistry, extra: Partial<AutonomyDispatchDeps>): AutonomyDispatchDeps {
  return {
    dataRoot: tmpRoot,
    agentSid: 'agent:test',
    workspaceId: 'default',
    defaultThreadId: 'thread-1',
    registry,
    kpiRegistry,
    imClient: null,
    toolCtx: {} as OuterToolContext,
    getLlmEnv: () => null,
    ...extra,
  };
}

describe('dispatcher focusOrder / strategyMode', () => {
  it('strategyMode + focusOrder 与 active 交集空 → strategy_no_focus（不掷闲聊）', async () => {
    const kpiRegistry = new KpiRegistry(tmpRoot);
    kpiRegistry.create({ description: '台湾情报', createdBy: 'u' }); // active，但不在 focusOrder
    const registry = new InnerBrainRegistry(tmpRoot);

    const r = await dispatchAutonomyTasks(
      deps(kpiRegistry, registry, { focusOrder: ['ghost-kpi'], strategyMode: true }),
      snapshot(),
      idleVerdict,
    );
    expect(r.dispatched).toBe(false);
    expect(r.reason).toBe('strategy_no_focus');
  });

  it('strategyMode 但 focusOrder 命中 active → 进入 KPI 路径（非 strategy_no_focus）', async () => {
    const kpiRegistry = new KpiRegistry(tmpRoot);
    const kpi = kpiRegistry.create({ description: '日本情报', createdBy: 'u' });
    const registry = new InnerBrainRegistry(tmpRoot);

    const r = await dispatchAutonomyTasks(
      deps(kpiRegistry, registry, { focusOrder: [kpi.kpiId], strategyMode: true }),
      snapshot(),
      idleVerdict,
    );
    // getLlmEnv=null → KPI 草拟失败前会先因 no_llm_env 等中止，但绝不会是 strategy_no_focus
    expect(r.reason).not.toBe('strategy_no_focus');
  });
});

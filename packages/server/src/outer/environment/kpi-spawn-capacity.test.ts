import { describe, expect, it } from 'vitest';

import { defaultAutonomyPolicy } from './autonomy-policy-store.js';
import type { EnvironmentSnapshot } from './environment-types.js';
import { evaluateKpiSpawnCapacity, hasAvailableCapacity } from './kpi-spawn-capacity.js';

function envWithInner(running: number): EnvironmentSnapshot {
  const at = new Date().toISOString();
  return {
    capturedAt: at,
    agentId: 'agent-test',
    facets: {
      innerBrains: {
        sensorId: 'innerBrains',
        capturedAt: at,
        data: { running, awaiting: 0, blocked: 0, asyncWaiting: 0 },
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

describe('evaluateKpiSpawnCapacity', () => {
  it('inner slot 满 → canSpawn false', () => {
    const policy = defaultAutonomyPolicy();
    policy.hardGates.maxRunningInnerBrains = 1;
    const cap = evaluateKpiSpawnCapacity(envWithInner(1), policy);
    expect(cap.canSpawn).toBe(false);
    expect(cap.hasInnerSlot).toBe(false);
    expect(cap.reason).toContain('running_inner');
  });

  it('有空槽 → canSpawn true', () => {
    const cap = evaluateKpiSpawnCapacity(envWithInner(0), defaultAutonomyPolicy());
    expect(cap.canSpawn).toBe(true);
    expect(cap.hasInnerSlot).toBe(true);
  });

  it('AWAITING 不占 RUNNING 容量，有剩余槽即 available', () => {
    const env = envWithInner(0);
    env.facets['innerBrains']!.data = {
      running: 0,
      awaiting: 7,
      blocked: 2,
      asyncWaiting: 7,
    };
    const policy = defaultAutonomyPolicy();
    policy.hardGates.maxRunningInnerBrains = 2;

    expect(hasAvailableCapacity(env, policy)).toEqual({
      available: true,
      freeInnerSlots: 2,
      freeLlmSlots: policy.hardGates.maxLlmInFlight,
      foregroundReservedSlots: 0,
    });
  });

  it('policy disabled is a hard gate even when slots are free', () => {
    const policy = defaultAutonomyPolicy();
    policy.enabled = false;
    expect(hasAvailableCapacity(envWithInner(0), policy)).toMatchObject({
      available: false,
      reason: 'autonomy_disabled',
    });
  });
});

describe('hasAvailableCapacity 自适应前台预留（P3 §6.4）', () => {
  function withInbound(env: EnvironmentSnapshot, queued: number, activeThreads: number) {
    env.facets['inbound']!.data = {
      orchestratorQueuedTotal: queued,
      outerLoopActiveThreads: activeThreads,
    };
    return env;
  }

  it('前台活跃 + 有富余槽 → 扣预留后仍可后台派发', () => {
    const policy = defaultAutonomyPolicy();
    policy.hardGates.maxRunningInnerBrains = 3;
    const cap = hasAvailableCapacity(withInbound(envWithInner(1), 0, 1), policy);
    expect(cap.available).toBe(true);
    expect(cap.foregroundReservedSlots).toBe(1);
    expect(cap.freeInnerSlots).toBe(1); // 3 - 1 running - 1 reserve
  });

  it('前台活跃 + 槽刚好被预留吃掉 → foreground_reserved 休眠', () => {
    const policy = defaultAutonomyPolicy();
    policy.hardGates.maxRunningInnerBrains = 2;
    const cap = hasAvailableCapacity(withInbound(envWithInner(1), 1, 0), policy);
    expect(cap.available).toBe(false);
    expect(cap.reason).toBe('foreground_reserved');
    expect(cap.freeInnerSlots).toBe(0);
  });

  it('前台安静 → 预留归零，同样负载可派发', () => {
    const policy = defaultAutonomyPolicy();
    policy.hardGates.maxRunningInnerBrains = 2;
    const cap = hasAvailableCapacity(withInbound(envWithInner(1), 0, 0), policy);
    expect(cap.available).toBe(true);
    expect(cap.foregroundReservedSlots).toBe(0);
    expect(cap.freeInnerSlots).toBe(1);
  });

  it('高压入站（queued 超阈值）→ inbound_pressure 全停', () => {
    const policy = defaultAutonomyPolicy();
    policy.hardGates.blockIfOrchestratorQueuedAbove = 2;
    const cap = hasAvailableCapacity(withInbound(envWithInner(0), 3, 0), policy);
    expect(cap.available).toBe(false);
    expect(cap.reason).toBe('inbound_pressure');
  });

  it('前台对话不再无条件全停（blockIfOuterLoopActive 仅兼容路径）', () => {
    const policy = defaultAutonomyPolicy();
    policy.hardGates.blockIfOuterLoopActive = true;
    policy.hardGates.maxRunningInnerBrains = 3;
    const cap = hasAvailableCapacity(withInbound(envWithInner(0), 0, 1), policy);
    expect(cap.available).toBe(true);
  });

  it('foregroundReserveSlots 可配置为 0（关闭预留）', () => {
    const policy = defaultAutonomyPolicy();
    policy.hardGates.maxRunningInnerBrains = 2;
    policy.hardGates.foregroundReserveSlots = 0;
    const cap = hasAvailableCapacity(withInbound(envWithInner(1), 1, 0), policy);
    expect(cap.available).toBe(true);
    expect(cap.foregroundReservedSlots).toBe(0);
  });

  it('默认策略 blockIfOuterLoopActive=false：前台活跃时兼容 advance 路径也不全停', () => {
    const policy = defaultAutonomyPolicy();
    expect(policy.hardGates.blockIfOuterLoopActive).toBe(false);
    const cap = evaluateKpiSpawnCapacity(withInbound(envWithInner(0), 0, 1), policy);
    expect(cap.canSpawn).toBe(true);
  });
});

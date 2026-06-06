import { describe, expect, it } from 'vitest';

import { defaultAutonomyPolicy } from './autonomy-policy-store.js';
import { evaluateAutonomyVerdict } from './autonomy-judge.js';
import type { ResourceSnapshot } from './autonomy-types.js';

function baseSnapshot(overrides: Partial<ResourceSnapshot> = {}): ResourceSnapshot {
  return {
    capturedAt: new Date().toISOString(),
    agentId: 'agent-test',
    innerBrains: { running: 0, awaiting: 0, blocked: 0, asyncWaiting: 0 },
    llm: { inFlight: 0, tokensLast1h: { prompt: 0, completion: 0, total: 0 }, callsLast1h: 0 },
    inbound: { orchestratorQueuedTotal: 0, outerLoopActiveThreads: 0 },
    im: { lastProactiveSpeakAt: null, proactiveCount5min: 0 },
    process: { heapUsedMb: 100, rssMb: 200 },
    ...overrides,
  };
}

describe('autonomy-judge', () => {
  it('passes when all hard gates clear', () => {
    const verdict = evaluateAutonomyVerdict(baseSnapshot(), defaultAutonomyPolicy());
    expect(verdict.level).toBe('idle');
    expect(verdict.reasons).toContain('hard_gates_pass');
  });

  it('blocks when running inner brains at cap', () => {
    const policy = defaultAutonomyPolicy();
    const verdict = evaluateAutonomyVerdict(
      baseSnapshot({
        innerBrains: { running: policy.hardGates.maxRunningInnerBrains, awaiting: 0, blocked: 0, asyncWaiting: 0 },
      }),
      policy,
    );
    expect(verdict.level).toBe('busy');
    expect(verdict.blockedByHardGate).toMatch(/running_inner/);
  });

  it('blocks when llm in-flight at cap', () => {
    const policy = defaultAutonomyPolicy();
    const verdict = evaluateAutonomyVerdict(
      baseSnapshot({ llm: { inFlight: 2, tokensLast1h: { prompt: 0, completion: 0, total: 0 }, callsLast1h: 0 } }),
      policy,
    );
    expect(verdict.level).toBe('busy');
    expect(verdict.blockedByHardGate).toMatch(/llm_in_flight/);
  });

  it('blocks when policy disabled', () => {
    const policy = { ...defaultAutonomyPolicy(), enabled: false };
    const verdict = evaluateAutonomyVerdict(baseSnapshot(), policy);
    expect(verdict.level).toBe('busy');
    expect(verdict.blockedByHardGate).toBe('policy.enabled=false');
  });
});

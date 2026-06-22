import { describe, expect, it } from 'vitest';

import { defaultAutonomyPolicy } from './autonomy-policy-store.js';
import type { EnvironmentSnapshot } from './environment-types.js';
import { evaluateKpiSpawnCapacity } from './kpi-spawn-capacity.js';

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
});

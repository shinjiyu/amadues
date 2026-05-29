import { describe, expect, it } from 'vitest';
import { InnerBrainRegistry } from './inner-brain-registry.js';
import { checkRunningInnerBrainCapacity, countRunningInnerBrains } from './inner-brain-capacity.js';
import { createTestDataRoot } from '../testing/temp-data-root.js';
import { saveAutonomyPolicy, defaultAutonomyPolicy } from './autonomy-policy-store.js';

describe('inner-brain-capacity', () => {
  it('仅 RUNNING 计入槽位，AWAITING 不计', () => {
    const root = createTestDataRoot('ibc-');
    const reg = new InnerBrainRegistry(root.dataRoot);
    const base = {
      workspaceId: 'ws',
      workDir: root.workspacesDir + '/ws',
      goal: 'g',
      originUser: 'u',
      startedAt: new Date().toISOString(),
    };
    reg.register({ ...base, instanceId: 'ib-r', status: 'RUNNING' });
    reg.register({ ...base, instanceId: 'ib-a', status: 'AWAITING' });
    expect(countRunningInnerBrains(reg)).toBe(1);

    const policy = defaultAutonomyPolicy();
    policy.hardGates.maxRunningInnerBrains = 3;
    saveAutonomyPolicy(root.dataRoot, policy);

    const cap = checkRunningInnerBrainCapacity(reg, root.dataRoot);
    expect(cap.ok).toBe(true);
    expect(cap.running).toBe(1);

    root.cleanup();
  });

  it('RUNNING 达上限时拒绝', () => {
    const root = createTestDataRoot('ibc-cap-');
    const reg = new InnerBrainRegistry(root.dataRoot);
    const policy = defaultAutonomyPolicy();
    policy.hardGates.maxRunningInnerBrains = 2;
    saveAutonomyPolicy(root.dataRoot, policy);
    const base = {
      workspaceId: 'ws',
      workDir: root.workspacesDir + '/ws',
      goal: 'g',
      originUser: 'u',
      startedAt: new Date().toISOString(),
    };
    reg.register({ ...base, instanceId: 'ib-1', status: 'RUNNING' });
    reg.register({ ...base, instanceId: 'ib-2', status: 'RUNNING' });
    const cap = checkRunningInnerBrainCapacity(reg, root.dataRoot);
    expect(cap.ok).toBe(false);
    root.cleanup();
  });
});

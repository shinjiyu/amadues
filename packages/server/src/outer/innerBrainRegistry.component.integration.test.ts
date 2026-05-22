/**
 * ADL component: innerBrainRegistry — register / list / awaiting
 */
import { afterEach, describe, expect, it } from 'vitest';

import { createTestDataRoot, type TestDataRoot } from '../testing/temp-data-root.js';
import { InnerBrainRegistry } from './inner-brain-registry.js';

describe('component: innerBrainRegistry', () => {
  let root: TestDataRoot;

  afterEach(() => {
    root?.cleanup();
  });

  it('register → get 主路径', () => {
    root = createTestDataRoot('ibr-');
    const reg = new InnerBrainRegistry(root.dataRoot);
    const id = reg.generateInstanceId();
    reg.register({
      instanceId: id,
      workspaceId: 'ws-1',
      workDir: root.workspacesDir + '/ws-1',
      goal: '目标',
      originUser: 'u1',
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
    });
    expect(reg.get(id)?.status).toBe('RUNNING');
    expect(reg.running()).toHaveLength(1);
  });

  it('awaiting 过滤', () => {
    root = createTestDataRoot('ibr-');
    const reg = new InnerBrainRegistry(root.dataRoot);
    const base = {
      workspaceId: 'ws-2',
      workDir: root.workspacesDir + '/ws-2',
      goal: 'g',
      originUser: 'u1',
      startedAt: new Date().toISOString(),
    };
    reg.register({ ...base, instanceId: 'ib-a', status: 'AWAITING' });
    reg.register({ ...base, instanceId: 'ib-b', status: 'DONE', finishedAt: new Date().toISOString() });
    expect(reg.awaiting().map((t) => t.instanceId)).toEqual(['ib-a']);
  });
});

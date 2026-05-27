/**
 * ADL component: registryLifecycleReconcile — 持久化 registry + workDir 对账
 * @see doc/structurizr/INNER-BRAIN-AWAITING-LIFECYCLE.md §5.1
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { addPending } from '../openkuroneko/pendings/index.js';
import { POST_COMPLETE_REASON } from './brain-async-snapshot.js';
import { InnerBrainRegistry, type TaskRecord } from './inner-brain-registry.js';
import { registryLifecycleReconcile } from './registry-lifecycle-reconcile.js';
import { createTestDataRoot, type TestDataRoot } from '../testing/temp-data-root.js';

describe('component: registryLifecycleReconcile', () => {
  let root: TestDataRoot;

  afterEach(() => {
    root?.cleanup();
  });

  it('重启后新 registry 实例：假 AWAITING → reconcile → DONE 落盘', () => {
    root = createTestDataRoot('reconcile-comp-');
    const workDir = path.join(root.workspacesDir, 'task-ib-fake-await');
    const brainDir = path.join(workDir, '.brain');
    fs.mkdirSync(brainDir, { recursive: true });

    addPending(brainDir, {
      kind: 'ask_user',
      spec: { prompt: POST_COMPLETE_REASON },
      source: 'all-complete',
    });
    fs.writeFileSync(
      path.join(brainDir, 'controller-state.json'),
      JSON.stringify({ mode: 'AWAITING', awaitingReason: POST_COMPLETE_REASON }),
      'utf8',
    );

    const record: TaskRecord = {
      instanceId: 'ib-fake-await-01',
      workspaceId: 'task-ib-fake-await',
      workDir,
      goal: 'done goal',
      originUser: 'human:u1',
      originThread: 'thread:comp',
      status: 'AWAITING',
      startedAt: new Date().toISOString(),
    };

    const before = new InnerBrainRegistry(root.dataRoot);
    before.register(record);

    const reloaded = new InnerBrainRegistry(root.dataRoot);
    expect(reloaded.get('ib-fake-await-01')?.status).toBe('AWAITING');

    const changes = registryLifecycleReconcile(reloaded);
    expect(changes).toHaveLength(1);
    expect(reloaded.get('ib-fake-await-01')?.status).toBe('DONE');

    const thirdLoad = new InnerBrainRegistry(root.dataRoot);
    expect(thirdLoad.get('ib-fake-await-01')?.status).toBe('DONE');
    expect(thirdLoad.get('ib-fake-await-01')?.finishedAt).toBeTruthy();
  });
});

/**
 * ADL component: awaitingInboundResolver — IM resolve → changeWatcher spawn 链
 * @see doc/structurizr/INNER-BRAIN-AWAITING-LIFECYCLE.md §5.2、§7
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { addPending, readPendings } from '../openkuroneko/pendings/index.js';
import { ChangeWatcher } from '../pi-mono/change-watcher.js';
import { InnerBrainRegistry, type TaskRecord } from './inner-brain-registry.js';
import { resolveAwaitingInboundFromIm } from './awaiting-inbound-resolver.js';
import type { ImInboundEvent } from './outer-brain.js';
import { createTestDataRoot, type TestDataRoot } from '../testing/temp-data-root.js';

const THREAD = 'thread:awaiting-comp';

describe('component: awaitingInboundResolver', () => {
  let root: TestDataRoot;
  let reg: InnerBrainRegistry;

  afterEach(() => {
    root?.cleanup();
  });

  function setupAwaitingAskUser(instanceId: string): { workDir: string; record: TaskRecord } {
    const workDir = path.join(root.workspacesDir, `task-${instanceId}`);
    const brainDir = path.join(workDir, '.brain');
    fs.mkdirSync(brainDir, { recursive: true });
    addPending(brainDir, {
      kind: 'ask_user',
      spec: { prompt: '请粘贴 Cookie' },
      deadline: new Date(Date.now() + 3600_000).toISOString(),
    });
    fs.writeFileSync(
      path.join(brainDir, 'controller-state.json'),
      JSON.stringify({ mode: 'AWAITING', awaitingReason: '等用户' }),
      'utf8',
    );
    const record: TaskRecord = {
      instanceId,
      workspaceId: `task-${instanceId}`,
      workDir,
      goal: 'test',
      originUser: 'human:alice',
      originThread: THREAD,
      status: 'AWAITING',
      startedAt: new Date().toISOString(),
    };
    reg.register(record);
    return { workDir, record };
  }

  it('人 IM 回复 → resolve pending → changeWatcher tick spawn（主路径）', async () => {
    root = createTestDataRoot('awaiting-res-comp-');
    reg = new InnerBrainRegistry(root.dataRoot);
    const { workDir, record } = setupAwaitingAskUser('ib-resolver-chain');

    const ev: ImInboundEvent = {
      threadId: THREAD,
      senderSid: 'human:alice',
      message: {
        message_id: 'msg-1',
        parts: [{ type: 'text', text: 'SUB=full-cookie-value' }],
      },
    };

    const resolved = await resolveAwaitingInboundFromIm(reg, ev);
    expect(resolved.resolved).toBe(true);
    expect(resolved.instanceId).toBe(record.instanceId);

    const pending = readPendings(path.join(workDir, '.brain'))[0];
    expect(pending?.status).toBe('resolved');
    expect((pending?.result as { reply?: string })?.reply).toBe('SUB=full-cookie-value');

    const spawned: TaskRecord[] = [];
    const watcher = new ChangeWatcher({
      registry: reg,
      spawnTask: (t) => {
        spawned.push(t);
        return { ok: true };
      },
    });
    await watcher.bootstrap();

    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.instanceId).toBe('ib-resolver-chain');
  });
});

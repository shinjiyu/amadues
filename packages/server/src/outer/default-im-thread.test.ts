import { describe, expect, it } from 'vitest';
import { InnerBrainRegistry } from './inner-brain-registry.js';
import {
  resolveDefaultImThreadId,
  resolveKpiBurstOriginThread,
  resolveTaskOriginThread,
} from './default-im-thread.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('default-im-thread', () => {
  it('resolveDefaultImThreadId prefers UTLRA_OUTER_HEARTBEAT_THREAD_ID', () => {
    expect(
      resolveDefaultImThreadId({
        UTLRA_OUTER_HEARTBEAT_THREAD_ID: 'webchat:global',
        UTLRA_CHAT_CHANNEL: 'webchat',
        WEBCHAT_GLOBAL_THREAD_ID: 'other',
      }),
    ).toBe('webchat:global');
  });

  it('resolveDefaultImThreadId derives webchat: prefix from WEBCHAT_GLOBAL_THREAD_ID', () => {
    expect(
      resolveDefaultImThreadId({
        UTLRA_CHAT_CHANNEL: 'webchat',
        WEBCHAT_GLOBAL_THREAD_ID: 'global',
      }),
    ).toBe('webchat:global');
  });

  it('resolveTaskOriginThread falls back to env default when ctx thread empty', () => {
    expect(
      resolveTaskOriginThread(undefined, '', {
        UTLRA_OUTER_HEARTBEAT_THREAD_ID: 'webchat:global',
      }),
    ).toBe('webchat:global');
  });

  it('resolveTaskOriginThread prefers explicit and ctx over env', () => {
    const env = { UTLRA_OUTER_HEARTBEAT_THREAD_ID: 'webchat:global' };
    expect(resolveTaskOriginThread('thread:dm', '', env)).toBe('thread:dm');
    expect(resolveTaskOriginThread(undefined, 'thread:ctx', env)).toBe('thread:ctx');
  });

  it('resolveKpiBurstOriginThread inherits from latest burst with originThread', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-reg-'));
    const reg = new InnerBrainRegistry(root);
    reg.register({
      instanceId: 'ib-old',
      workspaceId: 'task-ib-old',
      workDir: path.join(root, 'w1'),
      goal: 'g1',
      originUser: 'u1',
      originThread: 'webchat:global',
      status: 'DONE',
      startedAt: new Date().toISOString(),
    });
    reg.register({
      instanceId: 'ib-new',
      workspaceId: 'task-ib-new',
      workDir: path.join(root, 'w2'),
      goal: 'g2',
      originUser: 'u1',
      originThread: '',
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
    });
    expect(
      resolveKpiBurstOriginThread(['ib-old', 'ib-new'], reg, {
        UTLRA_OUTER_HEARTBEAT_THREAD_ID: 'webchat:fallback',
      }),
    ).toBe('webchat:global');
  });
});

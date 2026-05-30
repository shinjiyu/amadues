import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ThreadStore } from './threads.js';

describe('ThreadStore.clearMessages', () => {
  let dataRoot: string;
  let store: ThreadStore;

  beforeEach(async () => {
    dataRoot = mkdtempSync(path.join(tmpdir(), 'thread-store-test-'));
    store = new ThreadStore({ dataRoot, globalThreadId: 'global' });
    await store.init();
  });

  afterEach(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('removes all messages but keeps thread metadata', async () => {
    await store.appendMessage({
      thread_id: 'global',
      sender_user_id: 'alice',
      parts: [{ type: 'text', text: 'hello' }],
      text: 'hello',
      mentions: [],
      attachments: [],
    });
    await store.appendMessage({
      thread_id: 'global',
      sender_user_id: 'bob',
      parts: [{ type: 'text', text: 'world' }],
      text: 'world',
      mentions: [],
      attachments: [],
    });

    const deleted = await store.clearMessages('global');
    expect(deleted).toBe(2);

    const { messages } = await store.listMessages('global', undefined, 50);
    expect(messages).toEqual([]);
    expect(store.get('global')?.kind).toBe('group');
  });
});

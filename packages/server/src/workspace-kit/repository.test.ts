import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { FilesystemRepositoryStore } from './repository.js';

describe('FilesystemRepositoryStore', () => {
  let tmp: string;
  let store: FilesystemRepositoryStore;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
    store = new FilesystemRepositoryStore(tmp);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('commits and retrieves by keyword', () => {
    store.commitSession('t1', {
      session_id: 's1',
      realm: 'r1',
      lane: 'execution',
      items: [
        { kind: 'knowledge', title: 'API 路由', body: 'Hono /api/inner', tags: ['server'] },
        { kind: 'policy', title: '其它', body: 'nothing', tags: [] },
      ],
    });

    const hits = store.retrieve('t1', { query: '路由 Hono', lane: 'execution', limit: 10 });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.title).toContain('API');
  });

  it('isolates lanes', () => {
    store.commitSession('t1', {
      session_id: 's2',
      realm: 'r1',
      lane: 'interaction',
      items: [{ kind: 'knowledge', title: '聊天', body: 'thread dm', tags: [] }],
    });

    const ex = store.retrieve('t1', { query: '聊天', lane: 'execution' });
    expect(ex).toEqual([]);

    const ix = store.retrieve('t1', { query: '聊天', lane: 'interaction' });
    expect(ix.length).toBe(1);
  });

  it('listRecords returns newest first with optional lane filter', async () => {
    store.commitSession('t1', {
      session_id: 's-a',
      realm: 'r1',
      lane: 'execution',
      items: [{ kind: 'knowledge', title: 'older', body: 'a', tags: [] }],
    });
    await new Promise((r) => setTimeout(r, 5));
    store.commitSession('t1', {
      session_id: 's-b',
      realm: 'r1',
      lane: 'interaction',
      items: [{ kind: 'knowledge', title: 'lane ix', body: 'b', tags: [] }],
    });
    await new Promise((r) => setTimeout(r, 5));
    store.commitSession('t1', {
      session_id: 's-c',
      realm: 'r1',
      lane: 'execution',
      items: [{ kind: 'knowledge', title: 'newer', body: 'c', tags: [] }],
    });

    const all = store.listRecords('t1', { limit: 10 });
    expect(all[0]!.title).toBe('newer');

    const exOnly = store.listRecords('t1', { lane: 'execution', limit: 10 });
    expect(exOnly.every((e) => e.lane === 'execution')).toBe(true);
    expect(exOnly.some((e) => e.title === 'lane ix')).toBe(false);
    expect(exOnly[0]!.title).toBe('newer');
  });
});

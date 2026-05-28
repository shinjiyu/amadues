/**
 * @see doc/structurizr/MEMORY-BLOCKS.md §8
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryBlockStore } from './memory-block-store.js';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mb-store-'));
}

describe('MemoryBlockStore', () => {
  let root: string;
  let store: MemoryBlockStore;

  beforeEach(() => {
    root = tempRoot();
    store = new MemoryBlockStore({ dataRoot: root, agentId: 'kuro' });
  });

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('listBlocks includes system keychain', () => {
    const blocks = store.listBlocks();
    expect(blocks.some((b) => b.blockId === 'keychain' && b.system)).toBe(true);
  });

  it('create notebook block → put/get with body', async () => {
    await store.createBlock('project-notes', 'notebook', {
      title: '项目笔记',
      description: '长期备忘',
    });
    await store.put('project-notes', 'm1', {
      body: '# 里程碑\n完成 AIGC 报告',
      title: '里程碑',
      tags: 'aigc,report',
    });
    const meta = await store.get('project-notes', 'm1');
    expect(meta?.body).toContain('AIGC');
    expect(meta?.title).toBe('里程碑');
    const keys = await store.listEntryKeys('project-notes');
    expect(keys).toContain('m1');
    const indexFile = path.join(root, 'vault', 'blocks', 'blocks-index.json');
    expect(fs.existsSync(indexFile)).toBe(true);
  });

  it('put → get redacts value for keychain', async () => {
    await store.put('keychain', 'weibo', { kind: 'cookie', value: 'session=abc' });
    const meta = await store.get('keychain', 'weibo');
    expect(meta).toMatchObject({ key: 'weibo', kind: 'cookie' });
    expect(meta).not.toHaveProperty('value');
  });

  it('get with includeValue returns secret value', async () => {
    await store.put('keychain', 'api', { kind: 'token', value: 'tok-xyz' });
    const full = await store.get('keychain', 'api', { includeValue: true });
    expect(full?.value).toBe('tok-xyz');
  });

  it('deleteBlock removes user block and entries', async () => {
    await store.createBlock('tmp-block', 'notebook', { title: 't' });
    await store.put('tmp-block', 'e1', { body: 'x' });
    expect(await store.deleteBlock('tmp-block')).toBe(true);
    expect(store.listBlocks().some((b) => b.blockId === 'tmp-block')).toBe(false);
    await expect(store.listEntryKeys('tmp-block')).rejects.toThrow(/unknown block_id/);
  });

  it('cannot delete system keychain', async () => {
    await expect(store.deleteBlock('keychain')).rejects.toThrow(/system/);
  });

  it('unknown block_id throws on put', async () => {
    await expect(store.put('nope', 'k', { body: 'x' })).rejects.toThrow(/unknown block_id/);
  });
});

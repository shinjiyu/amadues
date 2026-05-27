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

  it('listBlocks includes keychain kv_secret', () => {
    const blocks = store.listBlocks();
    expect(blocks.some((b) => b.blockId === 'keychain' && b.strategy === 'kv_secret')).toBe(true);
  });

  it('put → listEntryKeys → get redacts value for keychain', async () => {
    await store.put('keychain', 'weibo', { kind: 'cookie', value: 'session=abc' });
    const keys = await store.listEntryKeys('keychain');
    expect(keys).toContain('weibo');
    const meta = await store.get('keychain', 'weibo');
    expect(meta).toMatchObject({ key: 'weibo', kind: 'cookie' });
    expect(meta).not.toHaveProperty('value');
  });

  it('get with includeValue returns secret value', async () => {
    await store.put('keychain', 'api', { kind: 'token', value: 'tok-xyz' });
    const full = await store.get('keychain', 'api', { includeValue: true });
    expect(full?.value).toBe('tok-xyz');
  });

  it('bind writes .brain/secrets under workDir', async () => {
    const workDir = path.join(root, 'ws-1');
    fs.mkdirSync(path.join(workDir, '.brain'), { recursive: true });
    await store.put('keychain', 'weibo', { kind: 'cookie', value: 'session=bind-me' });
    const paths = await store.bind('keychain', ['weibo'], workDir);
    expect(paths[0]).toBe('.brain/secrets/weibo.json');
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(workDir, '.brain', 'secrets', 'weibo.json'), 'utf8'),
    ) as { value: string };
    expect(onDisk.value).toBe('session=bind-me');
  });

  it('delete removes local entry', async () => {
    await store.put('keychain', 'tmp', { kind: 'x', value: 'v' });
    expect(await store.delete('keychain', 'tmp')).toBe(true);
    expect(await store.listEntryKeys('keychain')).not.toContain('tmp');
  });

  it('unknown block_id throws', async () => {
    await expect(store.put('nope', 'k', { value: 'x' })).rejects.toThrow(/unknown block_id/);
  });
});

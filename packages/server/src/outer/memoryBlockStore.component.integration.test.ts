/**
 * ADL component: memoryBlockStore — local vault + bind
 * @see doc/structurizr/MEMORY-BLOCKS.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMemoryBlockStore } from './memory-block-store.js';

describe('component: memoryBlockStore', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-comp-'));
  });

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('persists under dataRoot/vault/blocks/keychain/entries', async () => {
    const store = createMemoryBlockStore(root, null, 'gin');
    await store.put('keychain', 'site-a', { kind: 'cookie', value: 'a=1' });
    const file = path.join(root, 'vault', 'blocks', 'keychain', 'entries', 'site-a.json');
    expect(fs.existsSync(file)).toBe(true);
    const listed = await store.listEntryKeys('keychain');
    expect(listed).toContain('site-a');
  });

  it('bind path is readable as inner brain secret file', async () => {
    const store = createMemoryBlockStore(root);
    const workDir = path.join(root, 'workspaces', 'task-mb-1');
    fs.mkdirSync(path.join(workDir, '.brain'), { recursive: true });
    await store.put('keychain', 'cred', { kind: 'token', value: 'secret-42' });
    await store.bind('keychain', ['cred'], workDir);
    const bound = path.join(workDir, '.brain', 'secrets', 'cred.json');
    expect(fs.existsSync(bound)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(bound, 'utf8')) as { value: string };
    expect(parsed.value).toBe('secret-42');
  });
});

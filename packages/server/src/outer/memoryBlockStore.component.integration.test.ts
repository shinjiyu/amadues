/**
 * ADL component: memoryBlockStore — local vault persistence
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
});

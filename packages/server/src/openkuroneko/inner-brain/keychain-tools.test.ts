import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MemoryBlockStore } from '../../outer/memory-block-store.js';
import { createKeychainTools } from './keychain-tools.js';

function tmpDataRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kuroneko-keychain-'));
}

describe('createKeychainTools', () => {
  let dataRoot: string | undefined;

  afterEach(() => {
    if (dataRoot && fs.existsSync(dataRoot)) fs.rmSync(dataRoot, { recursive: true, force: true });
    dataRoot = undefined;
  });

  it('lists and reads keychain entries', async () => {
    dataRoot = tmpDataRoot();
    const store = new MemoryBlockStore({ dataRoot, agentId: 'test' });
    await store.put('keychain', 'ps_user', { kind: 'generic', value: 'alice' }, 'test');

    const [entries, get] = createKeychainTools({ dataRoot });
    const listRes = await entries.call({});
    expect(listRes.ok).toBe(true);
    expect(listRes.output).toContain('ps_user');

    const getRes = await get.call({ key: 'ps_user' });
    expect(getRes.ok).toBe(true);
    expect(getRes.output).toContain('alice');
  });

  it('fails when dataRoot missing', async () => {
    const prev = process.env['UTLRA_DATA_ROOT'];
    delete process.env['UTLRA_DATA_ROOT'];
    try {
      const [entries] = createKeychainTools();
      const res = await entries.call({});
      expect(res.ok).toBe(false);
      expect(res.output).toContain('UTLRA_DATA_ROOT');
    } finally {
      if (prev !== undefined) process.env['UTLRA_DATA_ROOT'] = prev;
    }
  });
});

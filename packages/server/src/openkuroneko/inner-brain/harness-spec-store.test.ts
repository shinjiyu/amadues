import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHarnessSpecStore } from './harness-spec-store.js';
import type { HarnessSpec } from './harness-types.js';

function draft(overrides: Partial<HarnessSpec> = {}): Omit<HarnessSpec, 'contentHash' | 'createdAt'> {
  return {
    id: 'hs-alpha',
    refs: {
      localNodeIds: ['local/login'],
      workflowRef: { id: 'collect', version: '1' },
    },
    status: 'draft',
    ...overrides,
  };
}

describe('harnessSpecStore', () => {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-spec-'));
  });
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('put writes immutable blob with contentHash and createdAt (H2)', () => {
    const store = createHarnessSpecStore(root);
    const saved = store.put(draft());
    expect(saved.contentHash).toMatch(/^[a-f0-9]{16,}$/);
    expect(saved.createdAt).not.toBe('');
    expect(fs.existsSync(path.join(root, '.brain', 'harness', 'specs', 'hs-alpha.json'))).toBe(true);
    expect(store.get('hs-alpha')?.refs.workflowRef).toEqual({ id: 'collect', version: '1' });
    expect(store.list()).toHaveLength(1);
  });

  it('put of existing id throws and does not rewrite refs', () => {
    const store = createHarnessSpecStore(root);
    store.put(draft());
    expect(() =>
      store.put(draft({ refs: { localNodeIds: ['local/other'] } })),
    ).toThrow(/immutable/);
    expect(store.get('hs-alpha')?.refs.localNodeIds).toEqual(['local/login']);
  });

  it('rejects path-traversal ids', () => {
    const store = createHarnessSpecStore(root);
    expect(() => store.put(draft({ id: '../evil' }))).toThrow(/invalid harness id/);
  });

  it('patchStatus only mutates status', () => {
    const store = createHarnessSpecStore(root);
    store.put(draft());
    const next = store.patchStatus('hs-alpha', 'gated_ok');
    expect(next.status).toBe('gated_ok');
    expect(next.refs.localNodeIds).toEqual(['local/login']);
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHarnessSpecStore } from './harness-spec-store.js';
import { createHarnessPointer } from './harness-pointer.js';
import { gateHarness } from './harness-gate.js';

describe('harnessGate', () => {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-gate-'));
  });
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('passes when asset files exist and marks gated_ok without upgrading (H3)', () => {
    fs.mkdirSync(path.join(root, '.run', 'ew'), { recursive: true });
    fs.writeFileSync(path.join(root, '.run', 'ew', 'ok.py'), 'print(1)\n');
    const store = createHarnessSpecStore(root);
    store.put({
      id: 'hs-ok',
      refs: { assetPaths: ['.run/ew/ok.py'] },
      status: 'draft',
    });
    const ptr = createHarnessPointer(root, store);
    const result = gateHarness(root, 'hs-ok', { store });
    expect(result.ok).toBe(true);
    expect(store.get('hs-ok')?.status).toBe('gated_ok');
    expect(ptr.readActive()).toBeNull();
  });

  it('fails missing assets: gated_fail and active stays (H3)', () => {
    const store = createHarnessSpecStore(root);
    store.put({ id: 'hs-parent', refs: { assetPaths: ['.run/ew/ok.py'] }, status: 'gated_ok' });
    store.put({
      id: 'hs-bad',
      parentId: 'hs-parent',
      refs: { assetPaths: ['.run/ew/missing.py'] },
      status: 'draft',
    });
    const ptr = createHarnessPointer(root, store);
    ptr.upgrade('hs-parent');
    const result = gateHarness(root, 'hs-bad', { store });
    expect(result.ok).toBe(false);
    expect(store.get('hs-bad')?.status).toBe('gated_fail');
    expect(ptr.readActive()?.harnessId).toBe('hs-parent');
  });

  it('fails parent regression when parent asset disappeared', () => {
    const store = createHarnessSpecStore(root);
    store.put({ id: 'hs-p', refs: { assetPaths: ['keep.txt'] }, status: 'gated_ok' });
    fs.writeFileSync(path.join(root, 'keep.txt'), 'x');
    store.put({
      id: 'hs-c',
      parentId: 'hs-p',
      refs: { assetPaths: ['keep.txt'] },
      status: 'draft',
    });
    fs.rmSync(path.join(root, 'keep.txt'));
    const result = gateHarness(root, 'hs-c', { store });
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => /keep\.txt/.test(r))).toBe(true);
  });
});

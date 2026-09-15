import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHarnessSpecStore } from './harness-spec-store.js';
import { createHarnessPointer } from './harness-pointer.js';
import { consumeHarnessRestartRequest, requestHarnessRestart } from './harness-restart.js';

describe('harnessRestart', () => {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-rst-'));
  });
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('requestHarnessRestart requires active H and is not a process spawn (H7)', () => {
    const store = createHarnessSpecStore(root);
    expect(() => requestHarnessRestart(root, { store })).toThrow(/active/);
    store.put({ id: 'hs-a', refs: {}, status: 'gated_ok' });
    createHarnessPointer(root, store).upgrade('hs-a');
    const req = requestHarnessRestart(root, { store });
    expect(req.harnessId).toBe('hs-a');
    expect(fs.existsSync(path.join(root, '.brain', 'harness', 'restart-requested.json'))).toBe(true);
  });

  it('consume is one-shot', () => {
    const store = createHarnessSpecStore(root);
    store.put({ id: 'hs-a', refs: {}, status: 'gated_ok' });
    createHarnessPointer(root, store).upgrade('hs-a');
    requestHarnessRestart(root, { store });
    expect(consumeHarnessRestartRequest(root)?.harnessId).toBe('hs-a');
    expect(consumeHarnessRestartRequest(root)).toBeNull();
  });
});

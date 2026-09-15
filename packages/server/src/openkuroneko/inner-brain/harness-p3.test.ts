import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHarnessSpecStore } from './harness-spec-store.js';
import { createHarnessPointer } from './harness-pointer.js';
import {
  hasPassedHeldOut,
  readHeldOutVerdict,
  runHeldOutGate,
} from './harness-held-out.js';
import { maySyncWorkflowToDrive9 } from './harness-drive9-sync.js';
import { isHarnessRsiCoveringWorkflow } from './harness-w15-dedup.js';
import { maybeAutoHeldOutAfterSuccess } from './harness-auto-held-out.js';

describe('harness P3 held-out / drive9 / w15', () => {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-p3-'));
  });
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('runHeldOutGate pass then maySync allows matching workflow', () => {
    fs.writeFileSync(path.join(root, 'ok.txt'), 'x');
    const store = createHarnessSpecStore(root);
    store.put({
      id: 'hs-1',
      refs: {
        assetPaths: ['ok.txt'],
        workflowRef: { id: 'ew-a', version: '1' },
      },
      status: 'gated_ok',
    });
    createHarnessPointer(root, store).upgrade('hs-1');

    expect(maySyncWorkflowToDrive9(root, 'ew-a', '2').ok).toBe(false);
    const v = runHeldOutGate(root, 'hs-1', { charterText: 'held-out charter A' });
    expect(v.passed).toBe(true);
    expect(hasPassedHeldOut(root, 'hs-1')).toBe(true);
    expect(readHeldOutVerdict(root, 'hs-1')?.fingerprint).toBeTruthy();
    expect(maySyncWorkflowToDrive9(root, 'ew-a', '2').ok).toBe(true);
  });

  it('maySync allows when no active harness or different workflow', () => {
    expect(maySyncWorkflowToDrive9(undefined, 'ew-a', '1').ok).toBe(true);
    expect(maySyncWorkflowToDrive9(root, 'ew-a', '1').ok).toBe(true);
    const store = createHarnessSpecStore(root);
    store.put({
      id: 'hs-1',
      refs: { workflowRef: { id: 'ew-a', version: '1' } },
      status: 'gated_ok',
    });
    createHarnessPointer(root, store).upgrade('hs-1');
    expect(maySyncWorkflowToDrive9(root, 'ew-other', '1').ok).toBe(true);
  });

  it('isHarnessRsiCoveringWorkflow when parentId set on active', () => {
    const store = createHarnessSpecStore(root);
    store.put({ id: 'hs-p', refs: { workflowRef: { id: 'ew-a', version: '1' } }, status: 'gated_ok' });
    store.put({
      id: 'hs-c',
      parentId: 'hs-p',
      refs: { workflowRef: { id: 'ew-a', version: '1' } },
      status: 'gated_ok',
    });
    createHarnessPointer(root, store).upgrade('hs-c');
    expect(isHarnessRsiCoveringWorkflow(root, 'ew-a')).toBe(true);
    expect(isHarnessRsiCoveringWorkflow(root, 'ew-b')).toBe(false);
  });

  it('maybeAutoHeldOutAfterSuccess records pass once', () => {
    fs.writeFileSync(path.join(root, 'ok.txt'), 'x');
    const store = createHarnessSpecStore(root);
    store.put({
      id: 'hs-1',
      refs: { assetPaths: ['ok.txt'], workflowRef: { id: 'ew-a', version: '1' } },
      status: 'gated_ok',
    });
    createHarnessPointer(root, store).upgrade('hs-1');
    const first = maybeAutoHeldOutAfterSuccess(root);
    expect(first?.passed).toBe(true);
    expect(maybeAutoHeldOutAfterSuccess(root)).toBeNull();
    expect(maySyncWorkflowToDrive9(root, 'ew-a', '2').ok).toBe(true);
  });
});

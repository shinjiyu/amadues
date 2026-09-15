import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHarnessPointer } from './harness-pointer.js';
import { createHarnessSpecStore } from './harness-spec-store.js';
import type { HarnessSpec } from './harness-types.js';

function spec(
  id: string,
  status: HarnessSpec['status'] = 'draft',
  parentId?: string,
): Omit<HarnessSpec, 'contentHash' | 'createdAt'> {
  return {
    id,
    parentId,
    refs: { localNodeIds: [id] },
    status,
  };
}

describe('harnessPointer', () => {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ptr-'));
  });
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('upgrade gated_ok sets active.json and history (H3)', () => {
    const store = createHarnessSpecStore(root);
    store.put(spec('hs-a', 'gated_ok'));
    const ptr = createHarnessPointer(root, store);
    const active = ptr.upgrade('hs-a');
    expect(active.harnessId).toBe('hs-a');
    expect(store.get('hs-a')?.status).toBe('active');
    const disk = JSON.parse(
      fs.readFileSync(path.join(root, '.brain', 'harness', 'active.json'), 'utf8'),
    ) as { harnessId: string };
    expect(disk.harnessId).toBe('hs-a');
    expect(ptr.readActive()?.harnessId).toBe('hs-a');
  });

  it('upgrade of draft throws and leaves active unchanged (H3)', () => {
    const store = createHarnessSpecStore(root);
    store.put(spec('hs-ok', 'gated_ok'));
    store.put(spec('hs-draft', 'draft'));
    const ptr = createHarnessPointer(root, store);
    ptr.upgrade('hs-ok');
    expect(() => ptr.upgrade('hs-draft')).toThrow(/gated_ok/);
    expect(ptr.readActive()?.harnessId).toBe('hs-ok');
  });

  it('second upgrade supersedes previous and records history', () => {
    const store = createHarnessSpecStore(root);
    store.put(spec('hs-a', 'gated_ok'));
    store.put(spec('hs-b', 'gated_ok', 'hs-a'));
    const ptr = createHarnessPointer(root, store);
    ptr.upgrade('hs-a');
    ptr.upgrade('hs-b');
    expect(store.get('hs-a')?.status).toBe('superseded');
    expect(store.get('hs-b')?.status).toBe('active');
    expect(ptr.readActive()?.harnessId).toBe('hs-b');
    const history = fs
      .readFileSync(path.join(root, '.brain', 'harness', 'history.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(history).toHaveLength(2);
  });

  it('rollback restores previously active H (H4)', () => {
    const store = createHarnessSpecStore(root);
    store.put(spec('hs-a', 'gated_ok'));
    store.put(spec('hs-b', 'gated_ok', 'hs-a'));
    const ptr = createHarnessPointer(root, store);
    ptr.upgrade('hs-a');
    ptr.upgrade('hs-b');
    ptr.rollback('hs-a');
    expect(ptr.readActive()?.harnessId).toBe('hs-a');
    expect(store.get('hs-a')?.status).toBe('active');
    expect(store.get('hs-b')?.status).toBe('superseded');
  });

  it('rollback rejects draft / gated_fail that was never active (H4)', () => {
    const store = createHarnessSpecStore(root);
    store.put(spec('hs-a', 'gated_ok'));
    store.put(spec('hs-fail', 'gated_fail'));
    const ptr = createHarnessPointer(root, store);
    ptr.upgrade('hs-a');
    expect(() => ptr.rollback('hs-fail')).toThrow(/rollback/);
    expect(ptr.readActive()?.harnessId).toBe('hs-a');
  });
});

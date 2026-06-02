import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { createMemoryStore } from './memory-store.js';
import type { FailureSummary, NodeResult } from './types.js';

function failure(nodeInstId: string): FailureSummary {
  return {
    nodeInstId,
    localRef: 'local/foo',
    summary: 'unrecoverable',
    attempted: ['retry login', 'switch path'],
    confidence: 'high',
    at: new Date().toISOString(),
  };
}

describe('memoryStore', () => {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-store-'));
  });
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns default memory when file missing', () => {
    const mem = createMemoryStore(root).read();
    expect(mem.constraints).toEqual([]);
    expect(mem.facts).toEqual([]);
    expect(mem.node_results).toEqual({});
    expect(mem.last_failure).toBeNull();
  });

  it('patch + get round-trips top-level key', () => {
    const store = createMemoryStore(root);
    store.patch('goal', 'win the battle');
    expect(store.get('goal')).toBe('win the battle');
  });

  it('get supports dotted path into node_results', () => {
    const store = createMemoryStore(root);
    const r: NodeResult = { nodeInstId: 'n1', ref: 'local/foo', ok: true, outputs: { result: 42 }, at: 'now' };
    store.recordNodeResult(r);
    expect(store.get('node_results.n1.outputs.result')).toBe(42);
  });

  it('recordNodeResult with failure mirrors last_failure', () => {
    const store = createMemoryStore(root);
    const r: NodeResult = { nodeInstId: 'n1', ref: 'local/foo', ok: false, failure: failure('n1'), at: 'now' };
    store.recordNodeResult(r);
    expect(store.read().last_failure?.nodeInstId).toBe('n1');
    expect(store.read().node_results['n1']?.ok).toBe(false);
  });

  it('clearLastFailure resets only the failure pointer', () => {
    const store = createMemoryStore(root);
    store.setLastFailure(failure('n1'));
    store.clearLastFailure();
    expect(store.read().last_failure).toBeNull();
  });

  it('appendFact / appendConstraint dedupe', () => {
    const store = createMemoryStore(root);
    store.appendFact('the moon is bright');
    store.appendFact('the moon is bright');
    store.appendConstraint('never delete prod');
    expect(store.read().facts).toEqual(['the moon is bright']);
    expect(store.read().constraints).toEqual(['never delete prod']);
  });
});

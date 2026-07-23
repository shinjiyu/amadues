import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ExecutableWorkflowStore,
  compareVersions,
  nextIntegerVersion,
} from './executable-workflow-store.js';
import type { ExecutableWorkflow } from './executable-workflow-types.js';

describe('executable-workflow-store', () => {
  let root: string;

  afterEach(() => {
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  function sample(partial?: Partial<ExecutableWorkflow>): ExecutableWorkflow {
    return {
      id: 'ew-demo',
      version: '1',
      kind: 'shell_pipeline',
      title: 'Demo',
      tags: ['t'],
      entry: 's1',
      steps: [
        {
          id: 's1',
          action: 'assert',
          expect: { fileExists: 'out.txt' },
        },
      ],
      failurePolicy: { onStepFail: 'abort_escalate', maxRetries: 1 },
      source: { promotedAt: '2026-07-23T00:00:00.000Z' },
      ...partial,
    };
  }

  it('put/get/list + version immutable', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-store-'));
    const store = new ExecutableWorkflowStore({ dataRoot: root });
    store.put(sample());
    expect(store.get({ id: 'ew-demo', version: '1' })?.title).toBe('Demo');
    expect(store.list()).toHaveLength(1);
    expect(store.getLatest('ew-demo')?.version).toBe('1');
    expect(() => store.put(sample())).toThrow(/immutable/);
  });

  it('put newer version updates latest', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-store-'));
    const store = new ExecutableWorkflowStore({ dataRoot: root });
    store.put(sample({ version: '1' }));
    store.put(sample({ version: '2', title: 'v2' }));
    expect(store.getMeta('ew-demo')?.latestVersion).toBe('2');
    expect(store.getLatest('ew-demo')?.title).toBe('v2');
  });

  it('rejects bad id', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-store-'));
    const store = new ExecutableWorkflowStore({ dataRoot: root });
    expect(() => store.put(sample({ id: '../x' }))).toThrow(/invalid id/);
  });

  it('compareVersions / nextIntegerVersion', () => {
    expect(compareVersions('2', '10')).toBeLessThan(0);
    expect(nextIntegerVersion(null)).toBe('1');
    expect(nextIntegerVersion('3')).toBe('4');
  });

  it('setPaused', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-store-'));
    const store = new ExecutableWorkflowStore({ dataRoot: root });
    store.put(sample());
    store.setPaused('ew-demo', true);
    expect(store.getMeta('ew-demo')?.paused).toBe(true);
  });
});

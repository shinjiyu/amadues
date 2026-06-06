import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';

import {
  buildRunContext,
  clearRunContext,
  readRunContext,
  writeRunContext,
} from './run-context-store.js';
import type { LocalDag } from './types.js';
import type { RunnerResult } from './runner.js';

describe('run-context-store', () => {
  let root = '';
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('round-trips run context through write/read/clear', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-ctx-'));
    const dag: LocalDag = {
      burstId: 'b1',
      designedAt: '2026-01-01T00:00:00.000Z',
      nodes: [{ id: 'n1', ref: 'preset/base', instruction: 'probe api' }],
      notes: 'test dag',
    };
    const res: RunnerResult = {
      ok: false,
      completed: [],
      failedAt: 'n1',
      results: [{
        nodeInstId: 'n1',
        ref: 'preset/base',
        ok: false,
        status: 'capped',
        failure: {
          nodeInstId: 'n1',
          localRef: 'preset/base',
          summary: 'safety cap',
          attempted: ['web_search'],
          confidence: 'low',
          transient: true,
          rawTail: 'use playwright fetch',
          at: '2026-01-01T00:01:00.000Z',
        },
        at: '2026-01-01T00:01:00.000Z',
      }],
      executionRecords: [{
        nodeInstId: 'n1',
        ref: 'preset/base',
        ok: false,
        status: 'capped',
        executionLog: [{ toolName: 'web_search', args: {}, result: { ok: true, output: 'ok' } }],
        failureSummary: 'safety cap',
        rawTail: 'use playwright fetch',
      }],
    };

    const ctx = buildRunContext(dag, res);
    writeRunContext(root, ctx);
    expect(fs.existsSync(path.join(root, '.brain', 'run-context.json'))).toBe(true);

    const loaded = readRunContext(root);
    expect(loaded?.ok).toBe(false);
    expect(loaded?.nodes[0]?.rawTail).toContain('playwright');
    expect(loaded?.results).toHaveLength(1);

    clearRunContext(root);
    expect(readRunContext(root)).toBeNull();
  });
});

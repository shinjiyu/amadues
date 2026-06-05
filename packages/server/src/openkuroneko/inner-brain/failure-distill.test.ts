import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { applyFailureDistill, distillRunFailures } from './failure-distill.js';
import { createMemoryStore } from './memory-store.js';
import type { NodeResult } from './types.js';

describe('distillRunFailures', () => {
  it('emits per-node and safety_cap constraints', () => {
    const lines = distillRunFailures({
      results: [
        {
          nodeInstId: 'n3',
          ref: 'preset/base',
          ok: false,
          status: 'capped',
          failure: {
            nodeInstId: 'n3',
            localRef: 'preset/base',
            summary: '达到安全轮次上限（50）仍未收敛',
            attempted: ['shell_exec'],
            confidence: 'low',
            transient: true,
            at: '',
          },
          at: '',
        },
      ],
      lastFailure: null,
    });
    expect(lines.some(l => l.includes('n3'))).toBe(true);
    expect(lines.some(l => l.includes('safety_cap'))).toBe(true);
  });

  it('adds 404 hint when last_failure mentions 404', () => {
    const lines = distillRunFailures({
      results: [],
      lastFailure: {
        nodeInstId: 'n1',
        localRef: 'preset/base',
        summary: 'curl got 404',
        attempted: [],
        confidence: 'high',
        at: '',
      },
    });
    expect(lines.some(l => l.includes('404'))).toBe(true);
  });
});

describe('applyFailureDistill', () => {
  it('dedupes constraints in memory store', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-'));
    const store = createMemoryStore(dir);
    const c = '[run-failure] test constraint';
    expect(applyFailureDistill(store, [c, c])).toBe(1);
    expect(store.read().constraints).toEqual([c]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { addPending } from '../pendings/index.js';
import { waitOnBench } from './bench-wait.js';

describe('waitOnBench', () => {
  it('returns after a due timer and records the outcome', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-wait-'));
    const brainDir = path.join(workDir, '.brain');
    fs.mkdirSync(brainDir, { recursive: true });
    addPending(brainDir, {
      kind: 'timer',
      spec: { execute_at: new Date(Date.now() - 1000).toISOString() },
    });

    const result = await waitOnBench(workDir, { pollMs: 10 });
    expect(result.continue).toBe(true);
    expect(result.notes.some((note) => note.includes('timer'))).toBe(true);
  });

  it('stops when the bench is asked to stop', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-wait-stop-'));
    const brainDir = path.join(workDir, '.brain');
    fs.mkdirSync(brainDir, { recursive: true });
    addPending(brainDir, {
      kind: 'ask_user',
      spec: { prompt: '还要一句' },
      deadline: new Date(Date.now() + 60_000).toISOString(),
    });
    fs.writeFileSync(path.join(workDir, '.stop-signal'), '1');

    const result = await waitOnBench(workDir, { pollMs: 10 });
    expect(result.continue).toBe(false);
  });
});

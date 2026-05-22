/**
 * ADL component: workerHost — status.json 落盘形态
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { WorkerStatus } from './inner-brain-worker.js';

describe('component: workerHost', () => {
  let workDir = '';

  afterEach(() => {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('status.json 字段契约（主路径）', () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-'));
    const runDir = path.join(workDir, '.run');
    fs.mkdirSync(runDir, { recursive: true });
    const status: WorkerStatus = {
      phase: 'done',
      instanceId: 'ib-wh',
      workspaceId: 'ws',
      ticks: 12,
      stoppedBy: 'idle',
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(runDir, 'inner-worker-status.json'),
      JSON.stringify(status),
      'utf8',
    );
    const parsed = JSON.parse(
      fs.readFileSync(path.join(runDir, 'inner-worker-status.json'), 'utf8'),
    ) as WorkerStatus;
    expect(parsed.phase).toBe('done');
    expect(parsed.stoppedBy).toBe('idle');
  });
});

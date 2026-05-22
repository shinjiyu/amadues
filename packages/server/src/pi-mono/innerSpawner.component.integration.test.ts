/**
 * ADL component: innerSpawner — readWorkerStatus / isPidAlive（不启真实子进程）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readWorkerStatus, isPidAlive } from './inner-brain-spawner.js';
import type { WorkerStatus } from './inner-brain-worker.js';

describe('component: innerSpawner', () => {
  let workDir = '';

  afterEach(() => {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('readWorkerStatus 读取 status.json（主路径）', () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-'));
    const runDir = path.join(workDir, '.run');
    fs.mkdirSync(runDir, { recursive: true });
    const status: WorkerStatus = {
      phase: 'running',
      instanceId: 'ib-x',
      workspaceId: 'ws',
      ticks: 3,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(runDir, 'inner-worker-status.json'),
      JSON.stringify(status),
      'utf8',
    );
    const got = readWorkerStatus(workDir);
    expect(got?.phase).toBe('running');
    expect(got?.ticks).toBe(3);
  });

  it('isPidAlive：当前进程 pid 为 true', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('isPidAlive：不存在的 pid 为 false', () => {
    expect(isPidAlive(2_147_483_647)).toBe(false);
  });
});

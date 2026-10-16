import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { appendBenchLog, writeClockInLogs } from './bench-log.js';
import { InnerBrainRegistry } from './inner-brain-registry.js';

describe('bench log', () => {
  it('copies other benches once at clock-in', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-log-'));
    const registry = new InnerBrainRegistry(root);
    const other = path.join(root, 'workspaces', 'task-other');
    const mine = path.join(root, 'workspaces', 'task-mine');
    fs.mkdirSync(other, { recursive: true });
    fs.mkdirSync(mine, { recursive: true });
    appendBenchLog(other, '交付 report.md — 写完了报告');
    registry.register({
      instanceId: 'ib-other',
      workspaceId: 'task-other',
      workDir: other,
      goal: '旧任务',
      originUser: 'u',
      originThread: 't',
      status: 'DONE',
      startedAt: new Date().toISOString(),
    });

    const result = writeClockInLogs(mine, registry, 'task-mine');
    const copied = fs.readFileSync(path.join(mine, '.brain', 'clock-in-logs.md'), 'utf8');
    expect(result.benches).toBe(1);
    expect(copied).toContain('report.md');
    expect(copied).toContain('task-other');
  });
});

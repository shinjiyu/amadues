import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TaskScheduler } from './task-scheduler.js';

describe('TaskScheduler digital employee recovery', () => {
  let root = '';

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps a missed commitment due on restart instead of executing outside the loop', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-recovery-'));
    const first = new TaskScheduler({
      dataRoot: root,
      deferMissedExecution: true,
    });
    await first.initialize();
    const id = await first.createTask({
      name: 'missed publish',
      schedule: { type: 'once', runAt: new Date(Date.now() - 60_000).toISOString() },
      action: { type: 'prompt', content: 'publish' },
      createdBy: { type: 'agent', id: 'a', name: 'agent' },
    });
    await first.shutdown();

    const executePromptAction = vi.fn();
    const restarted = new TaskScheduler({
      dataRoot: root,
      deferMissedExecution: true,
      executePromptAction,
    });
    await restarted.initialize();

    expect(executePromptAction).not.toHaveBeenCalled();
    expect(await restarted.getTask(id)).toMatchObject({
      id,
      status: 'active',
      nextRunAt: expect.any(String),
    });
  });
});

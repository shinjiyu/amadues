/**
 * ADL component: piMonoScheduler — stop 信号与 runtime 标签
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PI_MONO_RUNTIME_LABEL,
  writeStopSignal,
  clearStopSignal,
} from './run-tick.js';

describe('component: piMonoScheduler', () => {
  let workDir = '';

  afterEach(() => {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('embedded runtime 标签（主路径）', () => {
    expect(PI_MONO_RUNTIME_LABEL).toBe('embedded');
  });

  it('writeStopSignal / clearStopSignal 往返', () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sched-'));
    writeStopSignal(workDir);
    const stopFile = path.join(workDir, '.stop-signal');
    expect(fs.existsSync(stopFile)).toBe(true);
    clearStopSignal(workDir);
    expect(fs.existsSync(stopFile)).toBe(false);
  });
});

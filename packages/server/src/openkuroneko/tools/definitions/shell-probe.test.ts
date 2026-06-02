import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setWorkDirGuard } from './workdir-guard.js';
import { shellProbeTool } from './shell-probe.js';

describe('shellProbeTool', () => {
  let workDir: string;

  afterEach(() => {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('runs commands and stops on first ok output', async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-probe-'));
    setWorkDirGuard(workDir, workDir, []);
    const failCmd = process.platform === 'win32' ? 'cmd /c exit 1' : 'false';
    const okCmd =
      process.platform === 'win32'
        ? 'cmd /c echo probe-ok'
        : 'echo probe-ok';

    const r = await shellProbeTool.call({
      commands: JSON.stringify([failCmd, okCmd, okCmd]),
      stop_on_first_ok: true,
    });
    expect(r.ok).toBe(true);
    expect(r.output).toContain('probe-ok');
    expect(r.output).toContain('stopped early');
  });

  it('rejects empty commands', async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-probe-empty-'));
    setWorkDirGuard(workDir, workDir, []);
    const r = await shellProbeTool.call({ commands: '[]' });
    expect(r.ok).toBe(false);
  });
});

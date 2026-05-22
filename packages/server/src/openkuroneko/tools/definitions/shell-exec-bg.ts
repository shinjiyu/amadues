/**
 * shell_exec_bg — 后台启动长驻进程，立即返回 job_id
 *
 * 适用于：dev server、文件监听、长时间编译、CI pipeline 等。
 * 通过 shell_read_output 轮询输出，shell_kill 终止进程。
 *
 * 协议文档：doc/protocols/shell-exec-bg.md
 */

import path from 'node:path';
import { getWorkDir, getTempDir, isPathAllowed, pathSecurityError } from './workdir-guard.js';
import { spawnBackground } from '../../process/exec-runner.js';
import type { Tool } from '../index.js';

export const shellExecBgTool: Tool = {
  name: 'shell_exec_bg',
  description:
    'Start a long-running shell command in the background. Returns immediately with a job_id.\n' +
    'Use shell_read_output to poll stdout/stderr, shell_kill to terminate.\n\n' +
    'Use this for: dev servers, file watchers, long builds, multi-step pipelines.\n' +
    'Use shell_exec (not this) for commands that complete in under ~2 minutes.',
  parameters: {
    command: { type: 'string', description: 'Shell command to run in background' },
    cwd: {
      type: 'string',
      description: 'Working directory, must be inside workDir (defaults to workDir)',
    },
    label: {
      type: 'string',
      description: 'Optional human-readable label for this job (e.g. "dev-server", "build")',
    },
  },
  required: ['command'],

  async call(args): Promise<{ ok: boolean; output: string }> {
    const cmd    = String(args['command'] ?? '').trim();
    const cwdArg = args['cwd'] != null ? String(args['cwd']) : getWorkDir();
    const label  = args['label'] != null ? String(args['label']) : undefined;

    if (!cmd) return { ok: false, output: 'Missing required argument: command' };

    const resolvedCwd = path.resolve(cwdArg);
    if (!isPathAllowed(resolvedCwd)) {
      return { ok: false, output: pathSecurityError(resolvedCwd) };
    }

    const tempDir = getTempDir();
    const jobsDir = path.join(tempDir, '.jobs');

    const result = spawnBackground(cmd, { cwd: resolvedCwd, label, jobsDir });

    if (!result.ok) {
      return { ok: false, output: result.error ?? '后台启动失败' };
    }

    return {
      ok: true,
      output: JSON.stringify({
        job_id:      result.jobId,
        pid:         result.pid,
        stdout_file: result.stdoutFile,
        stderr_file: result.stderrFile,
        started_at:  result.startedAt,
        hint:        '使用 shell_read_output 轮询输出，shell_kill 终止进程',
      }, null, 2),
    };
  },
};

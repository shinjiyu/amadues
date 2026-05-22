/**
 * shell_read_output — 读取后台进程的输出，检查运行状态
 *
 * 协议文档：doc/protocols/shell-exec-bg.md
 */

import { getJob, tailFile } from '../../process/exec-runner.js';
import type { Tool } from '../index.js';

export const shellReadOutputTool: Tool = {
  name: 'shell_read_output',
  description:
    'Read stdout/stderr output from a background job started with shell_exec_bg.\n' +
    'Also returns whether the process is still running and its exit code.\n\n' +
    'Poll this in a loop to monitor long-running processes. ' +
    'For full output, use read_file with the stdout_file path.',
  parameters: {
    job_id: { type: 'string', description: 'Job ID returned by shell_exec_bg' },
    tail_lines: {
      type: 'number',
      description: 'Number of trailing stdout lines to return (default 50)',
    },
    include_stderr: {
      type: 'boolean',
      description: 'Also return last tail_lines of stderr (default false)',
    },
  },
  required: ['job_id'],

  async call(args): Promise<{ ok: boolean; output: string }> {
    const jobId        = String(args['job_id'] ?? '').trim();
    const tailLines    = Math.max(1, Math.min(Number(args['tail_lines']    ?? 50), 500));
    const inclStderr   = Boolean(args['include_stderr'] ?? false);

    if (!jobId) return { ok: false, output: 'Missing required argument: job_id' };

    const entry = getJob(jobId);
    if (!entry) {
      return { ok: false, output: `job not found: ${jobId}` };
    }

    const running  = entry.exitCode === null;
    const elapsed  = Date.now() - entry.startedAt.getTime();
    const stdoutTail = tailFile(entry.stdoutFile, tailLines);
    const result: Record<string, unknown> = {
      job_id:      jobId,
      label:       entry.label ?? null,
      pid:         entry.pid,
      running,
      elapsed_ms:  elapsed,
      stdout_tail: stdoutTail,
      stdout_file: entry.stdoutFile,
      stderr_file: entry.stderrFile,
    };

    if (!running) {
      result['exit_code'] = entry.exitCode;
    }
    if (inclStderr) {
      result['stderr_tail'] = tailFile(entry.stderrFile, tailLines);
    }

    return { ok: true, output: JSON.stringify(result, null, 2) };
  },
};

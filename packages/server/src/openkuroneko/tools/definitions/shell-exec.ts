/**
 * shell_exec — 在工作目录内执行 shell 命令（同步等待完成）
 *
 * 安全约束：cwd 必须在 workDir / tempDir / allowedDirs 内（通过 WorkDirGuard）
 * 底层使用 async spawn + 双超时（硬超时 + 无输出超时），不再阻塞主线程。
 */

import path from 'node:path';
import { getWorkDir, isPathAllowed, pathSecurityError } from './workdir-guard.js';
import { runCommand } from '../../process/exec-runner.js';
import type { Tool } from '../index.js';

export const shellExecTool: Tool = {
  name: 'shell_exec',
  description:
    'Execute a shell command within the agent workDir and wait for it to complete.\n' +
    'For long-running processes (servers, watchers, pipelines), use shell_exec_bg instead.',
  parameters: {
    command: { type: 'string', description: 'Shell command to run' },
    cwd: {
      type: 'string',
      description: 'Working directory, must be inside workDir (defaults to workDir)',
    },
    timeout: {
      type: 'number',
      description: 'Hard timeout in milliseconds (default 120000). Process is SIGKILL\'d on expiry.',
    },
    no_output_timeout: {
      type: 'number',
      description:
        'Kill process if no stdout/stderr for this many ms (default 60000). ' +
        'Useful for detecting hung processes.',
    },
  },
  required: ['command'],

  async call(args): Promise<{ ok: boolean; output: string }> {
    const cmd              = String(args['command']           ?? '').trim();
    const cwdArg           = args['cwd'] != null ? String(args['cwd']) : getWorkDir();
    const timeoutMs        = Math.min(Number(args['timeout']           ?? 120_000), 600_000); // max 10min
    const noOutputTimeoutMs = Math.min(Number(args['no_output_timeout'] ?? 60_000),  300_000); // max 5min

    if (!cmd) return { ok: false, output: 'Missing required argument: command' };

    const resolvedCwd = path.resolve(cwdArg);
    if (!isPathAllowed(resolvedCwd)) {
      return { ok: false, output: pathSecurityError(resolvedCwd) };
    }

    const result = await runCommand(cmd, { timeoutMs, noOutputTimeoutMs, cwd: resolvedCwd });
    return { ok: result.ok, output: result.output };
  },
};

/**
 * shell_kill — 向后台进程发送信号（终止或中断）
 *
 * 协议文档：doc/protocols/shell-exec-bg.md
 */

import { getJob, removeJob } from '../../process/exec-runner.js';
import type { Tool } from '../index.js';

const ALLOWED_SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP']);

export const shellKillTool: Tool = {
  name: 'shell_kill',
  description:
    'Send a signal to a background job started with shell_exec_bg.\n' +
    'Defaults to SIGTERM (graceful). Use SIGKILL for forced termination.\n' +
    'After killing, verify with shell_read_output that running=false.',
  parameters: {
    job_id: { type: 'string', description: 'Job ID returned by shell_exec_bg' },
    signal: {
      type: 'string',
      description: 'Signal to send: SIGTERM (default) | SIGKILL | SIGINT | SIGHUP',
    },
  },
  required: ['job_id'],

  async call(args): Promise<{ ok: boolean; output: string }> {
    const jobId  = String(args['job_id'] ?? '').trim();
    const signal = String(args['signal']  ?? 'SIGTERM').trim().toUpperCase();

    if (!jobId) return { ok: false, output: 'Missing required argument: job_id' };
    if (!ALLOWED_SIGNALS.has(signal)) {
      return { ok: false, output: `不支持的信号: ${signal}。允许: ${[...ALLOWED_SIGNALS].join(', ')}` };
    }

    const entry = getJob(jobId);
    if (!entry) {
      return { ok: false, output: `job not found: ${jobId}` };
    }

    if (entry.exitCode !== null) {
      removeJob(jobId);
      return {
        ok: true,
        output: `进程已退出（exit_code: ${entry.exitCode}），无需 kill。job 已从注册表移除。`,
      };
    }

    try {
      entry.process.kill(signal as NodeJS.Signals);
      removeJob(jobId);
      return {
        ok: true,
        output: `已向 pid ${entry.pid} 发送 ${signal}。job 已从注册表移除。`,
      };
    } catch (e) {
      return { ok: false, output: `kill 失败: ${String(e)}` };
    }
  },
};

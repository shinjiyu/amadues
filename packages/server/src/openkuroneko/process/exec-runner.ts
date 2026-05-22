/**
 * exec-runner — 异步 spawn 执行基础层
 *
 * 提供两个入口：
 *   runCommand()    — 等待完成（替换 execSync），支持硬超时 + 无输出超时
 *   spawnDetached() — 后台启动，立即返回进程句柄，stdout/stderr 写文件
 *
 * 协议文档：doc/protocols/shell-exec-bg.md
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ── 同步等待结果 ────────────────────────────────────────────────────────────

export interface RunResult {
  ok:          boolean;
  output:      string;           // stdout + stderr 合并
  exitCode:    number | null;
  /** 'exit' | 'timeout' | 'no-output-timeout' | 'signal' */
  termination: string;
  elapsedMs:   number;
}

export interface RunOptions {
  /** 硬超时（ms），超时后 SIGKILL。默认 120_000 */
  timeoutMs?:        number;
  /** 无输出超时（ms），超时后 SIGKILL。默认 60_000 */
  noOutputTimeoutMs?: number;
  cwd?:              string;
  env?:              NodeJS.ProcessEnv;
  /** 最大缓冲区（bytes）。默认 16 MB */
  maxOutputBytes?:   number;
}

const DEFAULT_TIMEOUT_MS         = 120_000;
const DEFAULT_NO_OUTPUT_TIMEOUT  = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES   = 16 * 1024 * 1024;

/**
 * 执行 shell 命令并等待完成（async 版 execSync）。
 * 超时时发送 SIGKILL 并在 output 中包含已收集的输出。
 */
export function runCommand(command: string, opts: RunOptions = {}): Promise<RunResult> {
  const {
    timeoutMs        = DEFAULT_TIMEOUT_MS,
    noOutputTimeoutMs = DEFAULT_NO_OUTPUT_TIMEOUT,
    cwd,
    env,
    maxOutputBytes   = DEFAULT_MAX_OUTPUT_BYTES,
  } = opts;

  return new Promise(resolve => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let noOutputTimedOut = false;
    let noOutputTimer: ReturnType<typeof setTimeout> | null = null;

    const child = spawn(command, {
      cwd,
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // 跨平台：Windows 走 cmd.exe /d /s /c，POSIX 走 sh -c。避免硬编码 'sh' 在 Windows 下 ENOENT。
      shell: true,
    });

    const finish = (termination: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (noOutputTimer) clearTimeout(noOutputTimer);

      const output = [stdout, stderr].filter(Boolean).join('\n');
      const exitCode = child.exitCode;
      const ok = termination === 'exit' && (exitCode ?? 1) === 0;

      let finalOutput = output;
      if (termination === 'timeout') {
        finalOutput = `[shell_exec] 硬超时 ${timeoutMs}ms\n` + output;
      } else if (termination === 'no-output-timeout') {
        finalOutput = `[shell_exec] 无输出超时 ${noOutputTimeoutMs}ms\n` + output;
      }

      resolve({ ok, output: finalOutput, exitCode, termination, elapsedMs: Date.now() - startedAt });
    };

    const armNoOutputTimer = () => {
      if (settled) return;
      if (noOutputTimer) clearTimeout(noOutputTimer);
      noOutputTimer = setTimeout(() => {
        noOutputTimedOut = true;
        child.kill('SIGKILL');
        finish('no-output-timeout');
      }, noOutputTimeoutMs);
    };

    const hardTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      finish('timeout');
    }, timeoutMs);

    armNoOutputTimer();

    child.stdout?.on('data', (d: Buffer) => {
      const chunk = d.toString();
      if (stdout.length + chunk.length <= maxOutputBytes) stdout += chunk;
      armNoOutputTimer();
    });
    child.stderr?.on('data', (d: Buffer) => {
      const chunk = d.toString();
      if (stderr.length + chunk.length <= maxOutputBytes) stderr += chunk;
      armNoOutputTimer();
    });

    child.on('error', err => {
      if (!settled) finish('exit');
      void (timedOut || noOutputTimedOut); // suppress lint
      void err;
    });
    child.on('close', () => {
      if (!settled) finish(timedOut ? 'timeout' : noOutputTimedOut ? 'no-output-timeout' : 'exit');
    });
  });
}

// ── 后台长驻进程 ─────────────────────────────────────────────────────────────

export interface JobEntry {
  jobId:      string;
  pid:        number;
  process:    ChildProcess;
  stdoutFile: string;
  stderrFile: string;
  startedAt:  Date;
  exitCode:   number | null;
  label?:     string | undefined;
}

/** 全局 JobRegistry（进程级单例） */
const jobRegistry = new Map<string, JobEntry>();

function newJobId(): string {
  return 'job-' + crypto.randomBytes(4).toString('hex');
}

export interface SpawnBgOptions {
  cwd?:    string | undefined;
  env?:    NodeJS.ProcessEnv | undefined;
  label?:  string | undefined;
  /** 存放 stdout/stderr 文件的目录（通常为 tempDir/.jobs/<id>/） */
  jobsDir: string;
}

export interface SpawnBgResult {
  ok:          boolean;
  jobId?:      string;
  pid?:        number;
  stdoutFile?: string;
  stderrFile?: string;
  startedAt?:  string;
  error?:      string;
}

/**
 * 后台启动进程，stdout/stderr 写入文件，立即返回。
 */
export function spawnBackground(command: string, opts: SpawnBgOptions): SpawnBgResult {
  const { cwd, env, label, jobsDir } = opts;
  const jobId = newJobId();
  const jobDir = path.join(jobsDir, jobId);

  try {
    fs.mkdirSync(jobDir, { recursive: true });
  } catch (e) {
    return { ok: false, error: `无法创建 job 目录: ${String(e)}` };
  }

  const stdoutFile = path.join(jobDir, 'stdout');
  const stderrFile = path.join(jobDir, 'stderr');

  let stdoutFd: number;
  let stderrFd: number;
  try {
    stdoutFd = fs.openSync(stdoutFile, 'a');
    stderrFd = fs.openSync(stderrFile, 'a');
  } catch (e) {
    return { ok: false, error: `无法创建输出文件: ${String(e)}` };
  }

  let child: ChildProcess;
  try {
    child = spawn(command, {
      cwd,
      env: env ?? process.env,
      stdio: ['ignore', stdoutFd, stderrFd],
      detached: false,
      // 跨平台：Windows 走 cmd.exe /d /s /c，POSIX 走 sh -c。
      shell: true,
    });
  } catch (e) {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    return { ok: false, error: `spawn 失败: ${String(e)}` };
  }

  // 关闭 fd（子进程已继承）
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);

  if (!child.pid) {
    return { ok: false, error: '进程启动失败（无 pid）' };
  }

  const entry: JobEntry = {
    jobId,
    pid:        child.pid,
    process:    child,
    stdoutFile,
    stderrFile,
    startedAt:  new Date(),
    exitCode:   null,
    label,
  };

  child.on('close', code => {
    const e = jobRegistry.get(jobId);
    if (e) e.exitCode = code ?? -1;
  });

  jobRegistry.set(jobId, entry);

  return {
    ok:          true,
    jobId,
    pid:         child.pid,
    stdoutFile,
    stderrFile,
    startedAt:   entry.startedAt.toISOString(),
  };
}

// ── JobRegistry 查询接口 ─────────────────────────────────────────────────────

export function getJob(jobId: string): JobEntry | undefined {
  return jobRegistry.get(jobId);
}

export function removeJob(jobId: string): void {
  jobRegistry.delete(jobId);
}

/** 读文件末尾 N 行（UTF-8） */
export function tailFile(filePath: string, lines: number): string {
  try {
    if (!fs.existsSync(filePath)) return '';
    const content = fs.readFileSync(filePath, 'utf8');
    const all = content.split('\n');
    return all.slice(Math.max(0, all.length - lines)).join('\n');
  } catch {
    return '';
  }
}

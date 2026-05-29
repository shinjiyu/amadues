/**
 * 子进程生命周期 + 跨平台 tree-kill + 环形日志缓冲。
 *
 * Windows：spawn 用 shell:true（让 .cmd 正常解析），stop 用 `taskkill /F /T /PID`（杀整棵进程树）。
 * *nix：   spawn 用 detached:true 起新进程组，stop 用 `process.kill(-pid, SIGTERM)` → SIGKILL。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import path from 'node:path';
import type { ServiceDef } from './service-registry.js';

export type ServiceStatus =
  | 'idle'        // 从未启动 / 已正常停止
  | 'starting'    // spawn 已发出，等待健康检查
  | 'running'     // 健康检查通过（或无健康检查但进程存活）
  | 'unhealthy'   // 进程存活但健康检查持续失败
  | 'stopping'    // 已发 kill 信号，等待退出
  | 'crashed'     // 进程退出但非主动停止
  | 'external';   // 端口被外部进程占用（不是我们 spawn 的）

export interface ServiceRuntime {
  def: ServiceDef;
  status: ServiceStatus;
  pid: number | null;
  startedAt: number | null;
  lastExitCode: number | null;
  lastExitSignal: string | null;
  lastError: string | null;
  /** 最近一次健康检查通过/失败时间戳（ms） */
  lastHealthOk: number | null;
  lastHealthCheck: number | null;
  /** 端口被外部占用时填入；none = 我们自己进程在用 */
  externalPid: number | null;
  /** 环形日志缓冲（最近 LOG_RING 行） */
  logs: LogLine[];
}

export interface LogLine {
  ts: number;
  stream: 'stdout' | 'stderr' | 'sys';
  text: string;
}

const LOG_RING = 1000;

const isWin = process.platform === 'win32';

export class ProcessManager {
  private runtimes = new Map<string, ServiceRuntime>();
  private children = new Map<string, ChildProcess>();
  /** 主动 stop 标记，区分 crashed 与正常 stop */
  private stopRequested = new Set<string>();

  constructor(defs: ServiceDef[]) {
    for (const def of defs) {
      this.runtimes.set(def.id, makeIdleRuntime(def));
    }
  }

  list(): ServiceRuntime[] {
    return [...this.runtimes.values()];
  }

  get(id: string): ServiceRuntime | undefined {
    return this.runtimes.get(id);
  }

  /** 直接覆盖 status 与外部占用信息（health-probe 调） */
  patch(id: string, patch: Partial<ServiceRuntime>): void {
    const r = this.runtimes.get(id);
    if (!r) return;
    Object.assign(r, patch);
  }

  appendLog(id: string, stream: LogLine['stream'], text: string): void {
    const r = this.runtimes.get(id);
    if (!r) return;
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      r.logs.push({ ts: Date.now(), stream, text: line });
    }
    if (r.logs.length > LOG_RING) {
      r.logs.splice(0, r.logs.length - LOG_RING);
    }
  }

  start(id: string): { ok: boolean; error?: string } {
    const r = this.runtimes.get(id);
    if (!r) return { ok: false, error: 'unknown service' };
    if (r.status === 'running' || r.status === 'starting') {
      return { ok: true };
    }
    if (r.status === 'external') {
      if (r.def.healthUrl) {
        // Docker agent：容器已跑、端口占用但无子进程
        return this.startViaScript(id, r);
      }
      return { ok: false, error: '端口被外部进程占用，请先释放或停止该进程' };
    }

    this.stopRequested.delete(id);
    r.status = 'starting';
    r.startedAt = Date.now();
    r.lastExitCode = null;
    r.lastExitSignal = null;
    r.lastError = null;
    r.lastHealthOk = null;
    r.lastHealthCheck = null;
    r.externalPid = null;

    const sysMsg = `[ops] spawn: ${r.def.cmd} ${r.def.args.join(' ')}  (cwd=${r.def.cwd})`;
    this.appendLog(id, 'sys', sysMsg);

    let child: ChildProcess;
    try {
      child = spawn(r.def.cmd, r.def.args, {
        cwd: r.def.cwd,
        env: { ...process.env },
        shell: isWin, // 让 npm.cmd 正常解析
        detached: !isWin,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      r.status = 'crashed';
      r.lastError = e instanceof Error ? e.message : String(e);
      this.appendLog(id, 'sys', `[ops] spawn failed: ${r.lastError}`);
      return { ok: false, error: r.lastError };
    }

    r.pid = child.pid ?? null;
    this.children.set(id, child);

    child.stdout?.on('data', (chunk: Buffer) =>
      this.appendLog(id, 'stdout', chunk.toString('utf8')),
    );
    child.stderr?.on('data', (chunk: Buffer) =>
      this.appendLog(id, 'stderr', chunk.toString('utf8')),
    );

    child.on('exit', (code, signal) => {
      r.lastExitCode = code;
      r.lastExitSignal = signal ?? null;
      r.pid = null;
      this.children.delete(id);
      const wasStop = this.stopRequested.has(id);
      this.stopRequested.delete(id);
      if (wasStop) {
        r.status = 'idle';
        this.appendLog(id, 'sys', `[ops] stopped (code=${code} signal=${signal ?? '-'})`);
      } else {
        r.status = 'crashed';
        this.appendLog(
          id,
          'sys',
          `[ops] crashed (code=${code} signal=${signal ?? '-'})`,
        );
      }
    });

    child.on('error', (e) => {
      r.lastError = e.message;
      this.appendLog(id, 'sys', `[ops] child error: ${e.message}`);
    });

    return { ok: true };
  }

  private startViaScript(id: string, r: ServiceRuntime): { ok: boolean; error?: string } {
    this.stopRequested.delete(id);
    r.status = 'starting';
    r.startedAt = Date.now();
    r.lastExitCode = null;
    r.lastExitSignal = null;
    r.lastError = null;
    r.lastHealthOk = null;
    r.lastHealthCheck = null;
    r.externalPid = null;
    return this.spawnChild(id, r);
  }

  private spawnChild(id: string, r: ServiceRuntime): { ok: boolean; error?: string } {
    const sysMsg = `[ops] spawn: ${r.def.cmd} ${r.def.args.join(' ')}  (cwd=${r.def.cwd})`;
    this.appendLog(id, 'sys', sysMsg);

    let child: ChildProcess;
    try {
      child = spawn(r.def.cmd, r.def.args, {
        cwd: r.def.cwd,
        env: { ...process.env },
        shell: isWin,
        detached: !isWin,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      r.status = 'crashed';
      r.lastError = e instanceof Error ? e.message : String(e);
      this.appendLog(id, 'sys', `[ops] spawn failed: ${r.lastError}`);
      return { ok: false, error: r.lastError };
    }

    r.pid = child.pid ?? null;
    this.children.set(id, child);

    child.stdout?.on('data', (chunk: Buffer) =>
      this.appendLog(id, 'stdout', chunk.toString('utf8')),
    );
    child.stderr?.on('data', (chunk: Buffer) =>
      this.appendLog(id, 'stderr', chunk.toString('utf8')),
    );

    child.on('exit', (code, signal) => {
      r.lastExitCode = code;
      r.lastExitSignal = signal ?? null;
      r.pid = null;
      this.children.delete(id);
      const wasStop = this.stopRequested.has(id);
      this.stopRequested.delete(id);
      if (wasStop) {
        r.status = 'idle';
        this.appendLog(id, 'sys', `[ops] stopped (code=${code} signal=${signal ?? '-'})`);
      } else {
        r.status = 'crashed';
        this.appendLog(
          id,
          'sys',
          `[ops] crashed (code=${code} signal=${signal ?? '-'})`,
        );
      }
    });

    child.on('error', (e) => {
      r.lastError = e.message;
      this.appendLog(id, 'sys', `[ops] child error: ${e.message}`);
    });

    return { ok: true };
  }

  async stop(id: string): Promise<{ ok: boolean; error?: string }> {
    const r = this.runtimes.get(id);
    if (!r) return { ok: false, error: 'unknown service' };
    const child = this.children.get(id);
    if (!child || child.pid == null) {
      if (r.def.stopScript) {
        r.status = 'stopping';
        this.appendLog(id, 'sys', `[ops] stop via script: ${r.def.stopScript}`);
        try {
          await runStopScript(r.def.cwd, r.def.stopScript);
          r.status = 'idle';
          r.externalPid = null;
          return { ok: true };
        } catch (e) {
          r.lastError = e instanceof Error ? e.message : String(e);
          r.status = 'external';
          return { ok: false, error: r.lastError };
        }
      }
      if (r.status === 'external') {
        return { ok: false, error: '该端口被外部进程占用，无法通过本工具停止' };
      }
      r.status = 'idle';
      return { ok: true };
    }
    this.stopRequested.add(id);
    r.status = 'stopping';
    this.appendLog(id, 'sys', `[ops] stopping pid=${child.pid}`);

    try {
      await killProcessTree(child.pid);
    } catch (e) {
      r.lastError = e instanceof Error ? e.message : String(e);
      this.appendLog(id, 'sys', `[ops] kill failed: ${r.lastError}`);
      return { ok: false, error: r.lastError };
    }

    return { ok: true };
  }

  async restart(id: string): Promise<{ ok: boolean; error?: string }> {
    const r = this.runtimes.get(id);
    if (!r) return { ok: false, error: 'unknown service' };
    const wasRunning =
      r.status === 'running' ||
      r.status === 'starting' ||
      r.status === 'unhealthy' ||
      r.status === 'external';
    if (wasRunning) {
      const sr = await this.stop(id);
      if (!sr.ok) return sr;
      // 等到 child exit 把 status 翻为 idle / crashed（最多 5s）
      await waitFor(() => {
        const cur = this.runtimes.get(id)!;
        return cur.status === 'idle' || cur.status === 'crashed';
      }, 5000);
    }
    return this.start(id);
  }

  /** 进程退出后由 health-probe 调用以决定 unhealthy / running */
  markHealth(id: string, ok: boolean): void {
    const r = this.runtimes.get(id);
    if (!r) return;
    const now = Date.now();
    r.lastHealthCheck = now;
    if (ok) {
      r.lastHealthOk = now;
      if (r.status === 'starting' || r.status === 'unhealthy' || r.status === 'external') {
        r.status = 'running';
      }
    } else if (r.status === 'running' || r.status === 'starting') {
      const inGrace =
        r.startedAt != null && now - r.startedAt < r.def.healthGraceMs;
      // 过了宽限期还没通过健康检查 → unhealthy（不论 starting 还是 running）
      // 这能让早崩、但 cmd.exe 外壳还挂着导致 child.on('exit') 没触发的情况
      // 至少在 UI 上从「启动中」翻成「不健康」，提示用户去看日志。
      if (!inGrace) {
        r.status = 'unhealthy';
      }
    }
  }

  /** 关闭进程时一并杀光自己 spawn 的子进程 */
  async dispose(): Promise<void> {
    const ids = [...this.children.keys()];
    await Promise.allSettled(ids.map((id) => this.stop(id)));
  }
}

function makeIdleRuntime(def: ServiceDef): ServiceRuntime {
  return {
    def,
    status: 'idle',
    pid: null,
    startedAt: null,
    lastExitCode: null,
    lastExitSignal: null,
    lastError: null,
    lastHealthOk: null,
    lastHealthCheck: null,
    externalPid: null,
    logs: [],
  };
}

async function killProcessTree(pid: number): Promise<void> {
  if (isWin) {
    await new Promise<void>((resolve, reject) => {
      execFile(
        'taskkill',
        ['/PID', String(pid), '/T', '/F'],
        { windowsHide: true },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    return;
  }
  // *nix：spawn 用 detached:true，pid 是新进程组的组长，-pid 杀整组
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* 已经死了 */
    }
  }
  // 800ms 后强杀兜底
  await new Promise((r) => setTimeout(r, 800));
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* ignore */
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return predicate();
}

function runStopScript(cwd: string, relScript: string): Promise<void> {
  const scriptPath = path.join(cwd, relScript);
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { cwd, windowsHide: true },
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

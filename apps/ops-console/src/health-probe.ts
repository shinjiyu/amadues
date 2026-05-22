/**
 * 周期 HTTP 健康检查 + TCP 端口占用检测。
 *
 * - HTTP 健康：访问 service.healthUrl，2xx = healthy。
 * - 端口检测：起 net.Server 短暂 listen，EADDRINUSE → 已被占用。
 *   * 占用方是我们 spawn 的子进程：什么都不做（status 由 ProcessManager 管）。
 *   * 占用方是外部：把 status 标为 external，禁止 start。
 */
import net from 'node:net';
import type { ProcessManager } from './process-manager.js';

export class HealthProbe {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly pm: ProcessManager,
    private readonly intervalMs = 3000,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    for (const r of this.pm.list()) {
      // 如果我们没启动它，且端口被占用 → external
      if (r.status === 'idle' || r.status === 'crashed' || r.status === 'external') {
        if (r.def.port != null) {
          const inUse = await isPortInUse(r.def.port);
          if (inUse && r.pid == null) {
            this.pm.patch(r.def.id, { status: 'external', externalPid: -1 });
            continue;
          }
          if (!inUse && r.status === 'external') {
            // 外部进程已退出，恢复 idle
            this.pm.patch(r.def.id, { status: 'idle', externalPid: null });
          }
        }
      }

      // 我们启动的服务：跑健康检查
      if (
        (r.status === 'starting' || r.status === 'running' || r.status === 'unhealthy') &&
        r.def.healthUrl
      ) {
        const ok = await checkHealth(r.def.healthUrl);
        this.pm.markHealth(r.def.id, ok);
      } else if (
        (r.status === 'starting' || r.status === 'running') &&
        !r.def.healthUrl &&
        r.startedAt != null
      ) {
        // 没有 healthUrl 的服务：spawn 后 grace 期一过就视为 running（pid 还在则信任之）
        const elapsed = Date.now() - r.startedAt;
        if (elapsed >= r.def.healthGraceMs) {
          this.pm.markHealth(r.def.id, true);
        }
      }
    }
  }
}

async function checkHealth(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer();
    let settled = false;
    const finish = (val: boolean) => {
      if (settled) return;
      settled = true;
      tester.close(() => resolve(val));
    };
    tester.once('error', (err: NodeJS.ErrnoException) => {
      finish(err.code === 'EADDRINUSE');
    });
    tester.once('listening', () => {
      finish(false);
    });
    try {
      tester.listen(port, '127.0.0.1');
    } catch {
      finish(true);
    }
  });
}

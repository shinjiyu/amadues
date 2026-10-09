/**
 * 审计镜像 — ADL doc/structurizr/AGENT-SUBJECT-DESIGN.md §6 监控隔离
 *
 * 把工具调用 / 自主决策事件实时推给另一系统用户运行的收集器（deploy/audit/audit_collector.py）。
 * agent 只能向 socket 追加，日志与哈希链由收集器持有。
 *
 * - 未设置 UTLRA_AUDIT_SOCKET 时完全 no-op
 * - 永不抛错、永不阻塞业务：断线时内存排队（有上限），重连后补发；溢出丢最旧并在心跳里报丢失数
 * - 每 60s 发心跳；收集器据此发现静默（被杀 / 被改代码停发）
 */
import net from 'node:net';

const SOCKET_ENV = 'UTLRA_AUDIT_SOCKET';
const MAX_QUEUE = 5000;
const HEARTBEAT_MS = 60_000;
const MAX_STRING = 8000;

export interface AuditMirrorDeps {
  socketPath: string;
  agent: string;
  connect?: (path: string) => net.Socket;
  now?: () => Date;
  heartbeatMs?: number;
}

export class AuditMirror {
  private sock: net.Socket | null = null;
  private connecting = false;
  private queue: string[] = [];
  private dropped = 0;
  private backoffMs = 500;
  private retryTimer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(private readonly deps: AuditMirrorDeps) {
    const every = deps.heartbeatMs ?? HEARTBEAT_MS;
    if (every > 0) {
      this.heartbeat = setInterval(() => this.emit('audit.heartbeat', { dropped: this.dropped }), every);
      this.heartbeat.unref();
    }
  }

  emit(kind: string, data: unknown): void {
    try {
      const line = JSON.stringify({
        v: 1,
        agent: this.deps.agent,
        pid: process.pid,
        ts: (this.deps.now?.() ?? new Date()).toISOString(),
        kind,
        data: capStrings(data),
      });
      this.queue.push(line);
      if (this.queue.length > MAX_QUEUE) {
        this.queue.splice(0, this.queue.length - MAX_QUEUE);
        this.dropped++;
      }
      this.flush();
    } catch {
      // 审计不得影响业务
    }
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.sock?.end();
    this.sock = null;
  }

  pendingCount(): number {
    return this.queue.length;
  }

  private flush(): void {
    if (!this.sock) {
      this.connect();
      return;
    }
    while (this.queue.length) {
      const line = this.queue.shift()!;
      this.sock.write(line + '\n');
    }
  }

  private connect(): void {
    if (this.connecting || this.retryTimer) return;
    this.connecting = true;
    const s = (this.deps.connect ?? ((p) => net.createConnection(p)))(this.deps.socketPath);
    s.unref();
    s.on('connect', () => {
      this.connecting = false;
      this.sock = s;
      this.backoffMs = 500;
      this.flush();
    });
    const onDown = () => {
      if (this.sock === s) this.sock = null;
      this.connecting = false;
      this.scheduleRetry();
    };
    s.on('error', onDown);
    s.on('close', onDown);
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.queue.length === 0) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, this.backoffMs);
    this.retryTimer.unref();
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
  }
}

function capStrings(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') {
    return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…[len=${v.length}]` : v;
  }
  if (depth > 6 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => capStrings(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = capStrings(x, depth + 1);
  return out;
}

let singleton: AuditMirror | null | undefined;

function resolveAgentName(env: NodeJS.ProcessEnv): string {
  return (
    env['UTLRA_AGENT_NAME']?.trim() ||
    env['UTLRA_PRIMARY_AGENT_SID']?.trim() ||
    'unknown'
  );
}

/** 进程级镜像；未配置 socket 返回 null。 */
export function getAuditMirror(env: NodeJS.ProcessEnv = process.env): AuditMirror | null {
  if (singleton !== undefined) return singleton;
  const socketPath = env[SOCKET_ENV]?.trim();
  singleton = socketPath ? new AuditMirror({ socketPath, agent: resolveAgentName(env) }) : null;
  return singleton;
}

export function mirrorAudit(kind: string, data: unknown): void {
  getAuditMirror()?.emit(kind, data);
}

/** agent 执行的 shell 命令不应看到审计通道配置。 */
export function scrubAuditEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!(SOCKET_ENV in env)) return env;
  const { [SOCKET_ENV]: _omit, ...rest } = env;
  return rest;
}

// 进程一加载就建连并开始心跳：空闲的 agent 也要能被发现"已失联"
getAuditMirror()?.emit('audit.process_start', { argv: process.argv.slice(1, 3) });

/** 单测用 */
export function resetAuditMirrorForTest(): void {
  singleton?.close();
  singleton = undefined;
}

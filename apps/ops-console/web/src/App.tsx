import React, { useEffect, useMemo, useRef, useState } from 'react';

type ServiceStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'unhealthy'
  | 'stopping'
  | 'crashed'
  | 'external';

interface ServiceDto {
  id: string;
  name: string;
  description: string;
  port: number | null;
  healthUrl: string | null;
  openUrl: string | null;
  dependsOn: string[];
  status: ServiceStatus;
  pid: number | null;
  startedAt: number | null;
  uptimeMs: number | null;
  lastExitCode: number | null;
  lastExitSignal: string | null;
  lastError: string | null;
  lastHealthOk: number | null;
  lastHealthCheck: number | null;
  externalPid: number | null;
  recentLogTail: { ts: number; stream: string; text: string }[];
}

interface LogLine {
  ts: number;
  stream: string;
  text: string;
}

const POLL_MS = 2000;
const STATUS_LABEL: Record<ServiceStatus, string> = {
  idle: '已停止',
  starting: '启动中',
  running: '运行中',
  unhealthy: '不健康',
  stopping: '停止中',
  crashed: '已崩溃',
  external: '外部占用',
};

export const App: React.FC = () => {
  const [services, setServices] = useState<ServiceDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [openLogsFor, setOpenLogsFor] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [lastTick, setLastTick] = useState<number>(Date.now());
  const logBoxRef = useRef<HTMLDivElement | null>(null);

  const refresh = async () => {
    try {
      const r = await fetch('/api/services');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { services: ServiceDto[]; now: number };
      setServices(j.services);
      setLastTick(j.now);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, []);

  // 轮询日志（只在打开的卡片下）
  useEffect(() => {
    if (!openLogsFor) return;
    let cancelled = false;
    const fetchLogs = async () => {
      try {
        const r = await fetch(
          `/api/services/${encodeURIComponent(openLogsFor)}/logs?tail=300`,
        );
        if (!r.ok) return;
        const j = (await r.json()) as { logs: LogLine[] };
        if (!cancelled) setLogs(j.logs);
      } catch {
        /* ignore */
      }
    };
    void fetchLogs();
    const t = setInterval(() => void fetchLogs(), 1500);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [openLogsFor]);

  // 自动滚到底
  useEffect(() => {
    if (logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [logs]);

  const setBusyFor = (id: string, on: boolean) => {
    setBusy((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const callAction = async (id: string, action: 'start' | 'stop' | 'restart') => {
    setBusyFor(id, true);
    try {
      const r = await fetch(`/api/services/${encodeURIComponent(id)}/${action}`, {
        method: 'POST',
      });
      const j = (await r.json()) as { ok?: boolean; error?: string };
      if (!j.ok) setError(j.error ?? `${action} failed`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyFor(id, false);
    }
  };

  const startAll = async () => {
    setBusyFor('__all__', true);
    try {
      const r = await fetch('/api/services/start-all', { method: 'POST' });
      const j = (await r.json()) as { results: { id: string; ok: boolean; error?: string }[] };
      const errs = j.results.filter((x) => !x.ok);
      if (errs.length) setError(errs.map((e) => `${e.id}: ${e.error ?? '?'}`).join(' / '));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyFor('__all__', false);
    }
  };

  const stopAll = async () => {
    setBusyFor('__all__', true);
    try {
      await fetch('/api/services/stop-all', { method: 'POST' });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyFor('__all__', false);
    }
  };

  const tickAge = useMemo(() => fmtAgo(lastTick), [lastTick]);

  return (
    <div className="app">
      <header className="toolbar">
        <div>
          <h1>
            utlra Ops Console
            <span className="sub">本地运维 · 上次刷新 {tickAge}</span>
          </h1>
        </div>
        <div className="actions">
          <button onClick={() => void refresh()}>刷新</button>
          <button
            className="primary"
            onClick={() => void startAll()}
            disabled={busy.has('__all__')}
          >
            全部启动
          </button>
          <button
            className="danger"
            onClick={() => void stopAll()}
            disabled={busy.has('__all__')}
          >
            全部停止
          </button>
        </div>
      </header>

      {error && <div className="error-banner">⚠ {error}</div>}

      <div className="cards">
        {services.map((s) => (
          <ServiceCard
            key={s.id}
            svc={s}
            busy={busy.has(s.id) || busy.has('__all__')}
            logsOpen={openLogsFor === s.id}
            onAction={(a) => void callAction(s.id, a)}
            onToggleLogs={() => {
              setOpenLogsFor((cur) => (cur === s.id ? null : s.id));
              setLogs([]);
            }}
          />
        ))}
      </div>

      {openLogsFor && (
        <LogsView
          serviceId={openLogsFor}
          logs={logs}
          boxRef={logBoxRef}
          onClose={() => setOpenLogsFor(null)}
        />
      )}
    </div>
  );
};

interface CardProps {
  svc: ServiceDto;
  busy: boolean;
  logsOpen: boolean;
  onAction: (a: 'start' | 'stop' | 'restart') => void;
  onToggleLogs: () => void;
}

const ServiceCard: React.FC<CardProps> = ({ svc, busy, logsOpen, onAction, onToggleLogs }) => {
  const isUp =
    svc.status === 'running' || svc.status === 'starting' || svc.status === 'unhealthy';
  return (
    <div className={`card ${svc.status}`}>
      <div className="card-head">
        <div>
          <h3>{svc.name}</h3>
          <div className="desc">{svc.description}</div>
        </div>
        <span className={`badge ${svc.status}`}>
          <span className="dot" />
          {STATUS_LABEL[svc.status]}
        </span>
      </div>

      <div className="kv">
        <span>端口</span>
        <b>{svc.port ?? '—'}</b>
        <span>PID</span>
        <b>
          {svc.pid ?? (svc.status === 'external' ? '外部进程' : '—')}
        </b>
        <span>运行时长</span>
        <b>{svc.uptimeMs != null ? fmtDuration(svc.uptimeMs) : '—'}</b>
        <span>健康检查</span>
        <b>
          {svc.healthUrl ? (
            <span title={svc.healthUrl}>
              {svc.lastHealthOk
                ? `✓ ${fmtAgo(svc.lastHealthOk)}`
                : svc.lastHealthCheck
                  ? `✗ ${fmtAgo(svc.lastHealthCheck)}`
                  : '—'}
            </span>
          ) : (
            '不主动探活'
          )}
        </b>
        {svc.dependsOn.length > 0 && (
          <>
            <span>依赖</span>
            <span className="deps">
              {svc.dependsOn.map((d) => (
                <code key={d}>{d}</code>
              ))}
            </span>
          </>
        )}
        {svc.lastError && (
          <>
            <span>错误</span>
            <b style={{ color: '#ff8c87' }}>{svc.lastError}</b>
          </>
        )}
      </div>

      <div className="actions-row">
        {!isUp && (
          <button
            className="primary"
            disabled={busy || svc.status === 'external'}
            onClick={() => onAction('start')}
          >
            启动
          </button>
        )}
        {isUp && (
          <button className="danger" disabled={busy} onClick={() => onAction('stop')}>
            停止
          </button>
        )}
        <button disabled={busy || svc.status === 'external'} onClick={() => onAction('restart')}>
          重启
        </button>
        {svc.openUrl && (
          <a
            className="open-link"
            href={svc.openUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={svc.openUrl}
          >
            打开 ↗
          </a>
        )}
        <button className="ghost logs-toggle" onClick={onToggleLogs}>
          {logsOpen ? '收起日志' : '查看日志'}
        </button>
      </div>
    </div>
  );
};

interface LogsViewProps {
  serviceId: string;
  logs: LogLine[];
  boxRef: React.MutableRefObject<HTMLDivElement | null>;
  onClose: () => void;
}

const LogsView: React.FC<LogsViewProps> = ({ serviceId, logs, boxRef, onClose }) => {
  return (
    <div style={{ marginTop: 24 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 8,
        }}
      >
        <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>
          日志 · <code style={{ color: 'var(--accent)' }}>{serviceId}</code> ·
          自动刷新 1.5s ·{' '}
          <span style={{ color: 'var(--text-dim)' }}>
            {logs.length} 行（最多保留 1000）
          </span>
        </div>
        <button onClick={onClose}>关闭</button>
      </div>
      <div className="logs" ref={boxRef}>
        {logs.length === 0 && (
          <div style={{ color: 'var(--text-dim)' }}>（暂无输出）</div>
        )}
        {logs.map((l, i) => (
          <div key={i} className={`line ${l.stream}`}>
            <span className="ts">{fmtTime(l.ts)}</span>
            <span className="body">{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const tz = 'Asia/Shanghai';
  const base = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d);
  const frac = String(d.getMilliseconds()).padStart(3, '0');
  return `${base}.${frac}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function fmtAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 1000) return '刚刚';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s 前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m 前`;
  return `${Math.floor(diff / 3_600_000)}h 前`;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return '<1s';
  const s = Math.floor(ms / 1000) % 60;
  const m = Math.floor(ms / 60_000) % 60;
  const h = Math.floor(ms / 3_600_000);
  if (h > 0) return `${h}h${m}m${s}s`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

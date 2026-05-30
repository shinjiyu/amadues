/**
 * 统一日志查看器 — IM 对话 + 外脑 tool 审计 + 内脑 Pi-mono I/O。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatWallClockTime } from '@utlra/chat-ir/serialize';
import { describePiLogEntry } from './inner-live.js';

type LogLane = 'chat' | 'outer' | 'inner' | 'autonomy' | 'trace' | 'directive';

type TimelineEntry = {
  ts: string;
  lane: LogLane;
  kind: string;
  title: string;
  subtitle?: string;
  round?: number;
  ok?: boolean;
  detail?: unknown;
  raw?: Record<string, unknown>;
};

type LogSession = {
  key: string;
  threadId: string;
  instanceId?: string;
  workspaceId?: string;
  startedAt: string;
  status?: string;
  goalPreview?: string;
  label: string;
};

type TimelineResponse = {
  entries: TimelineEntry[];
  meta: {
    threadId: string | null;
    instanceId: string | null;
    workspaceId: string | null;
    goal: string | null;
    status: string | null;
    outerRoundNumbers: number[];
    counts: Record<string, number>;
  };
};

const LANE_LABEL: Record<LogLane, string> = {
  chat: 'IM',
  outer: '外脑',
  inner: '内脑',
  autonomy: 'Autonomy',
  trace: 'Trace',
  directive: 'Directive',
};

const LANE_CLASS: Record<LogLane, string> = {
  chat: 'log-lane-chat',
  outer: 'log-lane-outer',
  inner: 'log-lane-inner',
  autonomy: 'log-lane-autonomy',
  trace: 'log-lane-trace',
  directive: 'log-lane-directive',
};

function formatTs(ts: string): string {
  if (!ts) return '—';
  try {
    return formatWallClockTime(ts, { compactToday: false });
  } catch {
    return ts;
  }
}

function groupOuterByRound(entries: TimelineEntry[]): Map<number, TimelineEntry[]> {
  const map = new Map<number, TimelineEntry[]>();
  for (const e of entries) {
    if (e.lane !== 'outer' || e.round == null) continue;
    const list = map.get(e.round) ?? [];
    list.push(e);
    map.set(e.round, list);
  }
  return map;
}

export function LogExplorerPanel({ apiPrefix }: { apiPrefix: string }) {
  const [sessions, setSessions] = useState<LogSession[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [threadId, setThreadId] = useState('webchat:global');
  const [instanceId, setInstanceId] = useState('');
  const [timeline, setTimeline] = useState<TimelineResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<TimelineEntry | null>(null);
  const [laneFilter, setLaneFilter] = useState<Set<LogLane>>(
    () => new Set(['chat', 'outer', 'inner', 'autonomy', 'trace', 'directive']),
  );
  const [focusRound, setFocusRound] = useState<number | 'all'>('all');

  const loadSessions = useCallback(async () => {
    try {
      const r = await fetch(`${apiPrefix}/logs/sessions?limit=50`);
      const j = (await r.json()) as { sessions?: LogSession[] };
      setSessions(j.sessions ?? []);
    } catch (e) {
      setErr(String(e));
    }
  }, [apiPrefix]);

  const loadTimeline = useCallback(async () => {
    if (!threadId.trim() && !instanceId.trim()) return;
    setLoading(true);
    setErr(null);
    try {
      const q = new URLSearchParams();
      if (threadId.trim()) q.set('thread_id', threadId.trim());
      if (instanceId.trim()) q.set('instance_id', instanceId.trim());
      q.set('limit', '1200');
      const r = await fetch(`${apiPrefix}/logs/timeline?${q}`);
      const j = (await r.json()) as TimelineResponse & { error?: string };
      if (!r.ok) throw new Error(j.error ?? r.statusText);
      setTimeline(j);
      setSelectedEntry(null);
      if (j.meta.outerRoundNumbers.length > 0 && focusRound === 'all') {
        setFocusRound(1);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setTimeline(null);
    } finally {
      setLoading(false);
    }
  }, [apiPrefix, threadId, instanceId]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    void loadTimeline();
  }, [loadTimeline]);

  const filteredEntries = useMemo(() => {
    if (!timeline) return [];
    return timeline.entries.filter((e) => {
      if (!laneFilter.has(e.lane)) return false;
      if (focusRound !== 'all' && e.lane === 'outer' && e.round != null && e.round !== focusRound) {
        return false;
      }
      return true;
    });
  }, [timeline, laneFilter, focusRound]);

  const outerRounds = timeline?.meta.outerRoundNumbers ?? [];
  const roundGroups = useMemo(
    () => groupOuterByRound(timeline?.entries ?? []),
    [timeline],
  );

  const toggleLane = (lane: LogLane) => {
    setLaneFilter((prev) => {
      const next = new Set(prev);
      if (next.has(lane)) next.delete(lane);
      else next.add(lane);
      return next;
    });
  };

  const pickSession = (s: LogSession) => {
    setSelectedKey(s.key);
    if (s.threadId) setThreadId(s.threadId);
    if (s.instanceId) setInstanceId(s.instanceId);
    else setInstanceId('');
  };

  return (
    <div className="log-explorer">
      <div className="log-explorer-toolbar card">
        <strong>日志查看器</strong>
        <span className="log-explorer-hint">
          合并 IM 对话、外脑 tool 调用、内脑 LLM/工具 I/O、autonomy 与 trace
        </span>
        <div className="log-explorer-fields">
          <label>
            thread_id
            <input value={threadId} onChange={(e) => setThreadId(e.target.value)} placeholder="webchat:global" />
          </label>
          <label>
            instance_id（内脑）
            <input value={instanceId} onChange={(e) => setInstanceId(e.target.value)} placeholder="ib-mpr…" />
          </label>
          <button type="button" onClick={() => void loadTimeline()} disabled={loading}>
            {loading ? '加载中…' : '刷新时间线'}
          </button>
        </div>
        {err && <div className="log-explorer-err">{err}</div>}
        {timeline?.meta && (
          <div className="log-explorer-meta">
            {timeline.meta.status && <span className="badge">{timeline.meta.status}</span>}
            {timeline.meta.workspaceId && <code>{timeline.meta.workspaceId}</code>}
            {Object.entries(timeline.meta.counts).map(([k, v]) => (
              v > 0 ? (
                <span key={k} className="log-count-pill">
                  {LANE_LABEL[k as LogLane] ?? k}: {v}
                </span>
              ) : null
            ))}
          </div>
        )}
      </div>

      <div className="log-explorer-body">
        <aside className="log-explorer-sidebar card">
          <div className="log-explorer-sidebar-title">会话 / 内脑实例</div>
          <div className="log-session-list">
            {sessions.length === 0 && <div className="inner-live-muted">无会话</div>}
            {sessions.map((s) => (
              <button
                key={s.key}
                type="button"
                className={`log-session-item${selectedKey === s.key ? ' active' : ''}`}
                onClick={() => pickSession(s)}
              >
                <div className="log-session-label">{s.label}</div>
                {s.threadId && <div className="log-session-sub">{s.threadId}</div>}
                <div className="log-session-ts">{formatTs(s.startedAt)}</div>
              </button>
            ))}
          </div>
        </aside>

        <main className="log-explorer-main">
          <div className="log-explorer-filters card">
            <span>泳道：</span>
            {(Object.keys(LANE_LABEL) as LogLane[]).map((lane) => (
              <button
                key={lane}
                type="button"
                className={`log-lane-toggle ${LANE_CLASS[lane]}${laneFilter.has(lane) ? ' on' : ''}`}
                onClick={() => toggleLane(lane)}
              >
                {LANE_LABEL[lane]}
              </button>
            ))}
            {outerRounds.length > 0 && (
              <>
                <span className="log-filter-sep">外脑轮次：</span>
                <button
                  type="button"
                  className={`log-round-btn${focusRound === 'all' ? ' on' : ''}`}
                  onClick={() => setFocusRound('all')}
                >
                  全部
                </button>
                {outerRounds.map((r) => (
                  <button
                    key={r}
                    type="button"
                    className={`log-round-btn${focusRound === r ? ' on' : ''}`}
                    onClick={() => setFocusRound(r)}
                  >
                    R{r}
                  </button>
                ))}
              </>
            )}
          </div>

          {focusRound !== 'all' && roundGroups.has(focusRound) && (
            <div className="card log-round-summary">
              <strong>外脑第 {focusRound} 轮</strong>
              <div className="log-round-tools">
                {roundGroups.get(focusRound)!.map((e, i) => (
                  <span key={i} className={`log-round-chip${e.ok === false ? ' fail' : ''}`}>
                    {e.title.replace(/^外脑 R\d+ · /, '')}
                  </span>
                ))}
              </div>
            </div>
          )}

          {timeline?.meta.goal && (
            <details className="card log-goal-fold">
              <summary>内脑 Goal</summary>
              <pre>{timeline.meta.goal}</pre>
            </details>
          )}

          <div className="log-timeline card">
            {filteredEntries.length === 0 ? (
              <div className="inner-live-muted">无条目（调整筛选或选择 instance / thread）</div>
            ) : (
              filteredEntries.map((e, i) => (
                <button
                  key={`${e.ts}-${e.lane}-${i}`}
                  type="button"
                  className={`log-timeline-row ${LANE_CLASS[e.lane]}${selectedEntry === e ? ' selected' : ''}`}
                  onClick={() => setSelectedEntry(e)}
                >
                  <div className="log-timeline-rail">
                    <span className={`log-lane-badge ${LANE_CLASS[e.lane]}`}>{LANE_LABEL[e.lane]}</span>
                    {e.round != null && <span className="log-round-badge">R{e.round}</span>}
                  </div>
                  <div className="log-timeline-content">
                    <div className="log-timeline-head">
                      <span className="log-timeline-ts">{formatTs(e.ts)}</span>
                      <span className="log-timeline-title">{e.title}</span>
                      {e.ok === true && <span className="log-ok">✓</span>}
                      {e.ok === false && <span className="log-fail">✗</span>}
                    </div>
                    {e.lane === 'inner' && e.raw && (
                      <div className="log-timeline-desc">{describePiLogEntry(e.raw)}</div>
                    )}
                    {e.subtitle && (
                      <pre className="log-timeline-sub">{e.subtitle}</pre>
                    )}
                  </div>
                </button>
              ))
            )}
          </div>
        </main>

        <aside className="log-explorer-detail card">
          <div className="log-explorer-sidebar-title">详情</div>
          {!selectedEntry ? (
            <div className="inner-live-muted">点击时间线条目查看完整 JSON</div>
          ) : (
            <>
              <div className="log-detail-head">
                <span className={`log-lane-badge ${LANE_CLASS[selectedEntry.lane]}`}>
                  {LANE_LABEL[selectedEntry.lane]}
                </span>
                <span>{selectedEntry.title}</span>
              </div>
              <div className="log-detail-ts">{formatTs(selectedEntry.ts)}</div>
              {selectedEntry.detail != null && (
                <>
                  <div className="log-explorer-sidebar-title" style={{ marginTop: 12 }}>
                    结构化 data
                  </div>
                  <pre className="log-detail-json">{JSON.stringify(selectedEntry.detail, null, 2)}</pre>
                </>
              )}
              {selectedEntry.raw && (
                <>
                  <div className="log-explorer-sidebar-title" style={{ marginTop: 12 }}>
                    原始 raw
                  </div>
                  <pre className="log-detail-json">{JSON.stringify(selectedEntry.raw, null, 2)}</pre>
                </>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

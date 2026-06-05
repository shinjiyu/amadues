/**
 * 节点触顶（Cap）告警面板 — baseNode / Designer 达 max rounds（safety_cap）且无产出时落盘。
 * ADL：doc/structurizr/INNER-BURST-STALL-ALERT.md
 */

import { useCallback, useEffect, useState } from 'react';
import { formatWallClockTime } from '@utlra/chat-ir/serialize';

export type StallAlertIndexEntry = {
  alertId: string;
  ts: string;
  instanceId: string;
  workspaceId: string;
  severity: 'warn' | 'critical';
  signals: string[];
  summary: string;
  bundlePath: string;
  bundlePathRepoRelative?: string;
};

type StallAlertsResponse = {
  dataRoot: string;
  agentId: string;
  count: number;
  alerts: StallAlertIndexEntry[];
};

type StallBundle = {
  cursor?: { snippet?: string; paths?: string[] };
  verdict?: { metrics?: Record<string, number> };
  tails?: { piMonoLogLines?: string[]; toolAuditLines?: string[] };
};

export function StallAlertsPanel({ apiPrefix }: { apiPrefix: string }) {
  const [alerts, setAlerts] = useState<StallAlertIndexEntry[]>([]);
  const [dataRoot, setDataRoot] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [bundle, setBundle] = useState<StallBundle | null>(null);
  const [copied, setCopied] = useState(false);

  const pull = useCallback(async () => {
    try {
      const r = await fetch(`${apiPrefix}/stall-alerts?limit=40`);
      if (!r.ok) {
        setErr(await r.text());
        return;
      }
      const j = (await r.json()) as StallAlertsResponse;
      setAlerts(j.alerts ?? []);
      setDataRoot(j.dataRoot ?? '');
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [apiPrefix]);

  useEffect(() => {
    void pull();
    const t = setInterval(() => void pull(), 8000);
    return () => clearInterval(t);
  }, [pull]);

  useEffect(() => {
    if (!selectedId) {
      setBundle(null);
      return;
    }
    void (async () => {
      try {
        const r = await fetch(`${apiPrefix}/stall-alerts/${encodeURIComponent(selectedId)}`);
        if (r.ok) setBundle((await r.json()) as StallBundle);
        else setBundle(null);
      } catch {
        setBundle(null);
      }
    })();
  }, [apiPrefix, selectedId]);

  const copySnippet = () => {
    const text = bundle?.cursor?.snippet ?? selected?.summary ?? '';
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const selected = alerts.find(a => a.alertId === selectedId) ?? alerts[0] ?? null;

  return (
    <div className="stall-alerts">
      <div className="stall-alerts-header">
        <h2 className="stall-alerts-title">节点触顶告警</h2>
        <p className="stall-alerts-hint">
          baseNode / Designer 达到 max rounds（<code>safety_cap</code>）且仍无 facts / deliverable 时自动落盘定位包。索引：
          <code>stall-alerts/index.jsonl</code>
          {dataRoot ? (
            <>
              {' '}
              · DATA_ROOT=<code>{dataRoot}</code>
            </>
          ) : null}
        </p>
        <button type="button" className="btn-secondary" onClick={() => void pull()}>
          刷新
        </button>
      </div>

      {err ? <p className="stall-alerts-err">{err}</p> : null}

      {alerts.length === 0 ? (
        <p className="stall-alerts-empty">暂无节点触顶告警（或 INNER_BURST_STALL_ALERT=0 已关闭）。</p>
      ) : (
        <div className="stall-alerts-grid">
          <ul className="stall-alerts-list">
            {alerts.map(a => (
              <li key={a.alertId}>
                <button
                  type="button"
                  className={`stall-alerts-item ${selectedId === a.alertId || (!selectedId && selected?.alertId === a.alertId) ? 'active' : ''}`}
                  onClick={() => setSelectedId(a.alertId)}
                >
                  <span className={`stall-sev stall-sev-${a.severity}`}>{a.severity}</span>
                  <span className="stall-alerts-item-id">{a.instanceId}</span>
                  <span className="stall-alerts-item-ts">{formatWallClockTime(a.ts)}</span>
                  <span className="stall-alerts-item-summary">{a.summary}</span>
                  <span className="stall-alerts-item-signals">{a.signals.join(' · ')}</span>
                </button>
              </li>
            ))}
          </ul>

          <div className="stall-alerts-detail">
            {selected ? (
              <>
                <h3>
                  {selected.instanceId}{' '}
                  <span className="stall-alerts-ws">{selected.workspaceId}</span>
                </h3>
                <p>
                  <strong>告警 ID</strong> <code>{selected.alertId}</code>
                </p>
                <p>
                  <strong>包路径</strong>{' '}
                  <code>{selected.bundlePathRepoRelative ?? selected.bundlePath}</code>
                </p>
                <button type="button" className="btn-primary" onClick={copySnippet}>
                  {copied ? '已复制 Cursor 片段' : '复制 Cursor 定位片段'}
                </button>

                {bundle?.cursor?.paths?.length ? (
                  <div className="stall-alerts-paths">
                    <strong>优先打开</strong>
                    <ul>
                      {bundle.cursor.paths.map(p => (
                        <li key={p}>
                          <code>{p}</code>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {bundle?.cursor?.snippet ? (
                  <pre className="stall-alerts-snippet">{bundle.cursor.snippet}</pre>
                ) : null}

                {bundle?.verdict?.metrics ? (
                  <pre className="stall-alerts-metrics">
                    {JSON.stringify(bundle.verdict.metrics, null, 2)}
                  </pre>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

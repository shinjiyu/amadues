/**
 * Executable Workflow 只读列表 — DATA_ROOT/workflows/
 * ADL：doc/structurizr/EXECUTABLE-WORKFLOW.md
 */
import { useCallback, useEffect, useState } from 'react';

type WorkflowMetaRow = {
  id: string;
  kind: string;
  title: string;
  latestVersion: string;
  tags: string[];
  updatedAt: string;
  paused?: boolean;
};

type WorkflowBody = {
  id: string;
  version: string;
  kind: string;
  title: string;
  tags: string[];
  entry: string;
  steps: Array<{ id: string; action: string; expect?: Record<string, unknown> }>;
  failurePolicy?: { onStepFail?: string; maxRetries?: number };
  source?: { promotedAt?: string; workspaceId?: string; agentId?: string };
};

const cardStyle: React.CSSProperties = {
  background: '#0d1117',
  border: '1px solid #2a3142',
  borderRadius: 6,
  padding: '0.75rem',
  fontSize: 12,
  color: '#c8d8ff',
};

const muted: React.CSSProperties = { fontSize: 11, color: '#5a6180', margin: '4px 0 0' };

export function WorkflowsPanel({ apiPrefix }: { apiPrefix: string }) {
  const [rows, setRows] = useState<WorkflowMetaRow[]>([]);
  const [dataRoot, setDataRoot] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkflowBody | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const pull = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${apiPrefix}/workflows`);
      if (!r.ok) {
        setErr(await r.text());
        return;
      }
      const j = (await r.json()) as { workflows?: WorkflowMetaRow[]; dataRoot?: string };
      const list = j.workflows ?? [];
      setRows(list);
      setDataRoot(j.dataRoot ?? '');
      setSelectedId((prev) => {
        if (prev && list.some((w) => w.id === prev)) return prev;
        return list[0]?.id ?? null;
      });
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [apiPrefix]);

  useEffect(() => {
    void pull();
    const t = setInterval(() => void pull(), 15_000);
    return () => clearInterval(t);
  }, [pull]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void (async () => {
      try {
        const r = await fetch(`${apiPrefix}/workflows/${encodeURIComponent(selectedId)}`);
        if (!r.ok) {
          setDetail(null);
          return;
        }
        const j = (await r.json()) as { workflow?: WorkflowBody };
        setDetail(j.workflow ?? null);
      } catch {
        setDetail(null);
      }
    })();
  }, [apiPrefix, selectedId]);

  const selected = rows.find((w) => w.id === selectedId) ?? null;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16, color: '#c8d8ff' }}>Executable Workflow</h2>
          <p style={muted}>
            已晋升冻结契约 · <code>DATA_ROOT/workflows/</code>
            {dataRoot ? (
              <>
                {' '}
                · <code>{dataRoot}</code>
              </>
            ) : null}
            {loading ? ' · 刷新中…' : null}
          </p>
        </div>
        <button type="button" className="btn-secondary" onClick={() => void pull()}>
          刷新
        </button>
      </div>

      {err ? <p style={{ color: '#f87171', fontSize: 12 }}>{err}</p> : null}

      {rows.length === 0 ? (
        <p style={muted}>暂无 EW。外脑 <code>workflow_promote</code> 后会出现在此。</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) 2fr', gap: 12, marginTop: 12 }}>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {rows.map((w) => (
              <li key={w.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(w.id)}
                  style={{
                    ...cardStyle,
                    width: '100%',
                    textAlign: 'left',
                    cursor: 'pointer',
                    borderColor: selectedId === w.id ? '#5b7ac5' : '#2a3142',
                    background: selectedId === w.id ? '#1a2236' : '#0d1117',
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{w.title || w.id}</div>
                  <div style={muted}>
                    <code>{w.id}</code>@{w.latestVersion} · {w.kind}
                    {w.paused ? ' · paused' : ''}
                  </div>
                  {w.tags?.length ? (
                    <div style={{ ...muted, marginTop: 4 }}>{w.tags.join(' · ')}</div>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>

          <div style={cardStyle}>
            {selected && detail ? (
              <>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
                  {detail.title}{' '}
                  <span style={muted}>
                    <code>
                      {detail.id}@{detail.version}
                    </code>
                  </span>
                </div>
                <p style={muted}>
                  kind=<code>{detail.kind}</code> · entry=<code>{detail.entry}</code>
                  {detail.source?.promotedAt ? ` · promoted ${detail.source.promotedAt}` : ''}
                  {detail.source?.workspaceId ? ` · ws=${detail.source.workspaceId}` : ''}
                </p>
                {detail.tags?.length ? (
                  <p style={muted}>tags: {detail.tags.join(', ')}</p>
                ) : null}
                <p style={{ ...muted, marginTop: 10 }}>steps ({detail.steps?.length ?? 0})</p>
                <ol style={{ margin: '4px 0 0', paddingLeft: 18, color: '#a8b4d0' }}>
                  {(detail.steps ?? []).map((s) => (
                    <li key={s.id} style={{ marginBottom: 4 }}>
                      <code>{s.id}</code> · {s.action}
                      {s.expect?.fileExists ? (
                        <>
                          {' '}
                          · expect file <code>{String(s.expect.fileExists)}</code>
                        </>
                      ) : null}
                      {s.expect?.stdoutContains ? (
                        <>
                          {' '}
                          · stdout⊃ <code>{String(s.expect.stdoutContains)}</code>
                        </>
                      ) : null}
                    </li>
                  ))}
                </ol>
                {detail.failurePolicy ? (
                  <p style={{ ...muted, marginTop: 10 }}>
                    fail: {detail.failurePolicy.onStepFail} · retries={detail.failurePolicy.maxRetries}
                  </p>
                ) : null}
              </>
            ) : (
              <p style={muted}>选择左侧一项查看详情</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

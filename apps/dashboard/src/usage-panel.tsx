import { useCallback, useEffect, useState } from 'react';

type UsageBucket = {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

type UsageSummary = {
  agentId: string;
  capturedAt: string;
  windowHours: number;
  totals: UsageBucket;
  runtime: {
    inFlight: number;
    tokensLast1h: { prompt: number; completion: number; total: number };
    callsLast1h: number;
  };
  bySource: Record<string, UsageBucket>;
  byModel: Record<string, UsageBucket>;
  recent: Array<{
    at: string;
    source: string;
    model: string;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
    ok: boolean;
    durationMs?: number;
  }>;
};

const SOURCE_LABEL: Record<string, string> = {
  outer_conversation: '外脑对话',
  outer_heartbeat: '外脑心跳',
  autonomy: '自主调度',
  performance_goal: '绩效目标',
  inner_llm_step: '内脑 LLM',
  inner_pi_mono: '内脑 Pi-mono',
  probe: '模型探针',
  unknown: '未知',
};

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div
      className="card"
      style={{ flex: '1 1 140px', minWidth: 140, padding: '12px 16px' }}
    >
      <div style={{ fontSize: 11, color: '#8b92a8', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color: '#c8d8ff' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#5a6180', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function BucketTable({
  title,
  rows,
  keyLabel,
}: {
  title: string;
  rows: Array<[string, UsageBucket]>;
  keyLabel: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="card" style={{ marginTop: 12 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>{title}</h3>
        <p style={{ fontSize: 12, color: '#5a6180', margin: 0 }}>暂无数据</p>
      </div>
    );
  }
  return (
    <div className="card" style={{ marginTop: 12, overflowX: 'auto' }}>
      <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>{title}</h3>
      <table className="viz-advanced-table" style={{ width: '100%', fontSize: 12 }}>
        <thead>
          <tr>
            <th>{keyLabel}</th>
            <th style={{ width: 60 }}>次数</th>
            <th style={{ width: 80 }}>prompt</th>
            <th style={{ width: 80 }}>completion</th>
            <th style={{ width: 80 }}>reasoning</th>
            <th style={{ width: 80 }}>total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([key, b]) => (
            <tr key={key}>
              <td>
                <code style={{ fontSize: 11 }}>{key}</code>
              </td>
              <td style={{ textAlign: 'center' }}>{b.calls}</td>
              <td style={{ textAlign: 'right', color: '#8b92a8' }}>{fmt(b.promptTokens)}</td>
              <td style={{ textAlign: 'right', color: '#8b92a8' }}>{fmt(b.completionTokens)}</td>
              <td style={{ textAlign: 'right', color: '#8b92a8' }}>{fmt(b.reasoningTokens)}</td>
              <td style={{ textAlign: 'right', color: '#c8d8ff' }}>{fmt(b.totalTokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function UsagePanel({ apiPrefix }: { apiPrefix: string }) {
  const [hours, setHours] = useState(24);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${apiPrefix}/usage/summary?hours=${hours}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setSummary((await r.json()) as UsageSummary);
    } catch (e) {
      setError(String(e));
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [apiPrefix, hours]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const byModel = summary
    ? Object.entries(summary.byModel).sort((a, b) => b[1].totalTokens - a[1].totalTokens)
    : [];
  const bySource = summary
    ? Object.entries(summary.bySource).sort((a, b) => b[1].totalTokens - a[1].totalTokens)
    : [];

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, color: '#8b92a8' }}>统计窗口</span>
        {[6, 24, 168].map((h) => (
          <button
            key={h}
            type="button"
            onClick={() => setHours(h)}
            style={{
              fontSize: 12,
              padding: '2px 10px',
              background: hours === h ? '#3b4a6b' : '#1d2333',
              border: hours === h ? '1px solid #5b7ac5' : '1px solid #2a3142',
              borderRadius: 4,
              color: hours === h ? '#c8d8ff' : '#8b92a8',
              cursor: 'pointer',
            }}
          >
            {h === 168 ? '7 天' : `${h}h`}
          </button>
        ))}
        <button type="button" onClick={() => void load()} style={{ fontSize: 12, marginLeft: 8 }}>
          {loading ? '刷新中…' : '刷新'}
        </button>
        {summary && (
          <span style={{ fontSize: 11, color: '#5a6180', marginLeft: 'auto' }}>
            {summary.agentId} · 更新 {new Date(summary.capturedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      {error && (
        <p style={{ color: '#f87171', fontSize: 13 }}>{error}</p>
      )}

      {summary && (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <KpiCard
              label={`${summary.windowHours}h 总 tokens`}
              value={fmt(summary.totals.totalTokens)}
              sub={`${summary.totals.calls} 次调用`}
            />
            <KpiCard
              label="近 1h tokens"
              value={fmt(summary.runtime.tokensLast1h.total)}
              sub={`${summary.runtime.callsLast1h} 次 · 内存滚动窗口`}
            />
            <KpiCard
              label="LLM 进行中"
              value={String(summary.runtime.inFlight)}
              sub="in-flight"
            />
            <KpiCard
              label="reasoning tokens"
              value={fmt(summary.totals.reasoningTokens)}
              sub={`${summary.windowHours}h 累计`}
            />
          </div>

          <BucketTable title="按模型" rows={byModel} keyLabel="模型" />
          <BucketTable
            title="按来源"
            rows={bySource.map(([k, v]) => [SOURCE_LABEL[k] ?? k, v])}
            keyLabel="来源"
          />

          <div className="card" style={{ marginTop: 12, overflowX: 'auto' }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>最近调用</h3>
            <table className="viz-advanced-table" style={{ width: '100%', fontSize: 12 }}>
              <thead>
                <tr>
                  <th style={{ width: 140 }}>时间</th>
                  <th style={{ width: 100 }}>来源</th>
                  <th>模型</th>
                  <th style={{ width: 70 }}>total</th>
                  <th style={{ width: 60 }}>耗时</th>
                </tr>
              </thead>
              <tbody>
                {summary.recent.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ color: '#5a6180' }}>暂无记录</td>
                  </tr>
                )}
                {[...summary.recent].reverse().slice(0, 20).map((e, i) => (
                  <tr key={`${e.at}-${i}`}>
                    <td style={{ color: '#8b92a8' }}>{new Date(e.at).toLocaleString()}</td>
                    <td>{SOURCE_LABEL[e.source] ?? e.source}</td>
                    <td><code style={{ fontSize: 11 }}>{e.model}</code></td>
                    <td style={{ textAlign: 'right' }}>{fmt(e.totalTokens)}</td>
                    <td style={{ textAlign: 'right', color: '#8b92a8' }}>
                      {e.durationMs != null ? `${e.durationMs}ms` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <p style={{ fontSize: 11, color: '#5a6180', marginTop: 12 }}>
        数据来自 <code>{apiPrefix}/usage/summary</code>，持久化于 <code>usage/llm-usage.jsonl</code>。
        内脑 Pi-mono 子进程在流式响应末 chunk 含 usage 时也会写入。
      </p>
    </div>
  );
}

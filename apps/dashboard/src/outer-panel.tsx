import { useCallback, useEffect, useState } from 'react';

type OuterInnerStatusResponse = {
  status?: Record<string, unknown>;
};

function formatOuterStatus(status: unknown): { lines: string[]; raw: unknown } {
  if (status == null || typeof status !== 'object') {
    return { lines: ['（无内脑状态）'], raw: status };
  }
  const s = status as Record<string, unknown>;
  const lines: string[] = [];
  const pick = (label: string, key: string) => {
    const v = s[key];
    if (v !== undefined && v !== null && v !== '') lines.push(`${label}：${String(v)}`);
  };
  pick('控制器模式', 'controllerMode');
  pick('阶段', 'phase');
  pick('Registry', 'registryStatus');
  pick('实例', 'instanceId');
  pick('等待原因', 'awaitingReason');
  pick('阻塞原因', 'blockedReason');
  pick('Goal 摘要', 'goalPreview');
  if (lines.length === 0) {
    for (const [k, v] of Object.entries(s)) {
      if (v != null && typeof v !== 'object') lines.push(`${k}：${String(v)}`);
    }
  }
  return { lines: lines.length ? lines : ['（状态对象为空）'], raw: status };
}

export function OuterPanel({ workspaceId, apiPrefix = '/api' }: { workspaceId: string; apiPrefix?: string }) {
  const [outerStatus, setOuterStatus] = useState<unknown>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);

  const pullStatus = useCallback(async () => {
    setStatusErr(null);
    try {
      const r = await fetch(`${apiPrefix}/outer/inner-status/${encodeURIComponent(workspaceId)}`);
      if (!r.ok) {
        setStatusErr(await r.text());
        return;
      }
      const j = (await r.json()) as OuterInnerStatusResponse;
      setOuterStatus(j.status ?? j);
    } catch (e) {
      setStatusErr(e instanceof Error ? e.message : String(e));
    }
  }, [apiPrefix, workspaceId]);

  useEffect(() => {
    const id = setInterval(() => void pullStatus(), 3000);
    void pullStatus();
    return () => clearInterval(id);
  }, [pullStatus]);

  const { lines, raw } = formatOuterStatus(outerStatus);

  return (
    <div>
      <div className="card">
        <strong>外脑观测 · 内脑快照</strong>
        <p style={{ fontSize: 12, color: '#8b92a8', margin: '6px 0 10px' }}>
          Workspace <code>{workspaceId}</code> · 每 3s 自动刷新（只读）
        </p>
        {statusErr && <div style={{ color: '#f0a8a8', marginBottom: 8 }}>{statusErr}</div>}
        {outerStatus == null && !statusErr ? (
          <p style={{ color: '#8b92a8', fontSize: 13 }}>加载中…</p>
        ) : (
          <>
            <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 14, lineHeight: 1.7, color: '#c8d8ff' }}>
              {lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <details className="viz-advanced" style={{ marginTop: 8 }}>
              <summary style={{ fontSize: 12, color: '#8b92a8', cursor: 'pointer' }}>原始 JSON</summary>
              <pre
                style={{
                  margin: '8px 0 0',
                  maxHeight: 280,
                  overflow: 'auto',
                  padding: 10,
                  background: '#12151c',
                  borderRadius: 6,
                  border: '1px solid #2a3142',
                  fontSize: 11,
                }}
              >
                {JSON.stringify(raw, null, 2)}
              </pre>
            </details>
          </>
        )}
      </div>
    </div>
  );
}

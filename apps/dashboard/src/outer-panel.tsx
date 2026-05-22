import { useCallback, useEffect, useState } from 'react';

const IM_CHAT_HINT = 'http://localhost:5175';

type OuterInnerStatusResponse = {
  status?: Record<string, unknown>;
};

type RoundtripResponse = {
  ok?: boolean;
  error?: string;
  reply?: unknown;
  mock?: unknown;
  innerStatus?: Record<string, unknown> | null;
  workerExitCode?: number;
  workerStdout?: string;
  lifecycle?: unknown;
  threadHistory?: unknown;
  goalVisionEnriched?: boolean;
  outerReplyLlm?: boolean;
  skipped?: boolean;
  skipReason?: string;
  runInner?: boolean;
  shouldReplyReason?: string;
};

export function OuterPanel({ workspaceId, apiPrefix = '/api' }: { workspaceId: string; apiPrefix?: string }) {
  const [outerStatus, setOuterStatus] = useState<unknown>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [threadId, setThreadId] = useState('thread:outer');
  const [senderSid, setSenderSid] = useState('idp:agent:assistant');
  const [text, setText] = useState('你好，外脑联调');
  const [threadKind, setThreadKind] = useState<'dm' | 'group'>('dm');
  const [busy, setBusy] = useState(false);
  const [lastRt, setLastRt] = useState<RoundtripResponse | null>(null);
  const [rtErr, setRtErr] = useState<string | null>(null);
  const [shutdownBusy, setShutdownBusy] = useState(false);

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
    const q = new URLSearchParams(window.location.search).get('thread_id');
    if (q?.trim()) setThreadId(q.trim());
  }, []);

  useEffect(() => {
    const id = setInterval(() => void pullStatus(), 2000);
    void pullStatus();
    return () => clearInterval(id);
  }, [pullStatus]);

  const runRoundtrip = async () => {
    setRtErr(null);
    setBusy(true);
    try {
      const r = await fetch(`${apiPrefix}/outer/roundtrip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          thread_id: threadId.trim(),
          workspace_id: workspaceId,
          sender_sid: senderSid.trim(),
          text: text.trim(),
          thread_kind: threadKind,
        }),
      });
      const j = (await r.json()) as RoundtripResponse;
      if (!r.ok) {
        setRtErr(j.error ?? JSON.stringify(j));
        setLastRt(null);
        return;
      }
      setLastRt(j);
      void pullStatus();
    } catch (e) {
      setRtErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const shutdown = async (promote: boolean) => {
    if (
      !confirm(
        promote
          ? '将 manifest 晋升到 Repository 后关闭内脑（SLEEPING）？'
          : '仅关闭内脑（SLEEPING），不晋升 manifest？',
      )
    ) {
      return;
    }
    setShutdownBusy(true);
    try {
      const r = await fetch(`${apiPrefix}/outer/workspace/${encodeURIComponent(workspaceId)}/shutdown`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promote_manifest: promote }),
      });
      const j = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok) alert(j.error ?? await r.text());
      else void pullStatus();
    } finally {
      setShutdownBusy(false);
    }
  };

  return (
    <div>
      <p className="inner-tab-hint">
        <strong>外脑</strong>负责：渠道消息 → 落库 → 设 Goal → 触发内脑 burst → StructuredReply / 生命周期策略。
        下方「内脑快照」与 <code>GET /api/outer/inner-status</code> 同源，便于观察 roundtrip 之后内脑状态；与「内脑」页的 Pi 实况互补（那边偏交互，这里偏编排结果）。
      </p>
      <p className="inner-tab-hint" style={{ borderLeft: '3px solid #3d5a80', paddingLeft: 10 }}>
        <strong>IM（人 → agent）联调：</strong>先启动 agent（<code>npm run dev</code>），再开聊天页{' '}
        <a href={IM_CHAT_HINT}>{IM_CHAT_HINT}</a>。IM 与 roundtrip 共用 <code>UTLRA_DATA_ROOT/chat</code>；会话须含 agent。
        用户发消息后由 IM 协议路径在进程内触发 <code>runOuterRoundtrip</code>。将下方 <code>thread_id</code> 与 IM 会话一致；或 URL 加{' '}
        <code>?thread_id=thread:...</code>。
      </p>

      <div className="card">
        <strong>内脑快照（外脑只读观测 · 每 2s 刷新）</strong>
        <p style={{ fontSize: 12, color: '#8b92a8', margin: '6px 0 8px' }}>
          与内脑 Tab 读的是同一 workspace 状态机；此处强调「经外脑 API 写入后的观测入口」。
        </p>
        {statusErr && <div style={{ color: '#f0a8a8', marginBottom: 8 }}>{statusErr}</div>}
        <pre
          style={{
            margin: 0,
            maxHeight: 220,
            overflow: 'auto',
            padding: 10,
            background: '#12151c',
            borderRadius: 6,
            border: '1px solid #2a3142',
          }}
        >
          {outerStatus == null ? '加载中…' : JSON.stringify(outerStatus, null, 2)}
        </pre>
        <button type="button" style={{ marginTop: 8 }} onClick={() => void pullStatus()}>
          立即刷新
        </button>
      </div>

      <div className="card">
        <strong>执行外脑 roundtrip</strong>
        <p style={{ fontSize: 12, color: '#8b92a8', margin: '6px 0 10px' }}>
          <code>POST /api/outer/roundtrip</code> — 与 chat IR 同源（agent 8787）；落 <code>UTLRA_DATA_ROOT</code> 下 <code>chat/threads.json</code>。
        </p>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <label style={{ flex: '1 1 200px' }}>
            thread_id
            <input value={threadId} onChange={(e) => setThreadId(e.target.value)} />
          </label>
          <label style={{ flex: '1 1 200px' }}>
            sender_sid
            <input value={senderSid} onChange={(e) => setSenderSid(e.target.value)} />
          </label>
          <label>
            thread_kind
            <select value={threadKind} onChange={(e) => setThreadKind(e.target.value as 'dm' | 'group')}>
              <option value="dm">dm</option>
              <option value="group">group</option>
            </select>
          </label>
        </div>
        <label style={{ display: 'block', marginTop: 8 }}>
          text
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <div className="row" style={{ marginTop: 10, gap: 8 }}>
          <button type="button" disabled={busy} onClick={() => void runRoundtrip()}>
            {busy ? 'roundtrip 执行中…' : '发送并跑外脑 roundtrip'}
          </button>
        </div>
        {rtErr && (
          <pre style={{ color: '#f0a8a8', marginTop: 10, whiteSpace: 'pre-wrap' }}>{rtErr}</pre>
        )}
        {lastRt && (
          <div style={{ marginTop: 12 }}>
            <strong style={{ fontSize: 13 }}>上一轮返回摘要</strong>
            <ul style={{ fontSize: 12, color: '#b8bfd4', margin: '6px 0' }}>
              <li>
                skipped: {String(lastRt.skipped)} {lastRt.skipReason ? `（${lastRt.skipReason}）` : ''}
              </li>
              <li>runInner: {String(lastRt.runInner)}</li>
              <li>shouldReplyReason: {lastRt.shouldReplyReason ?? '—'}</li>
              <li>workerExitCode: {lastRt.workerExitCode ?? '—'}</li>
              <li>goalVisionEnriched / outerReplyLlm: {String(lastRt.goalVisionEnriched)} / {String(lastRt.outerReplyLlm)}</li>
            </ul>
            <pre
              style={{
                marginTop: 8,
                maxHeight: 360,
                overflow: 'auto',
                padding: 10,
                background: '#12151c',
                borderRadius: 6,
                border: '1px solid #2a3142',
                fontSize: 11,
              }}
            >
              {JSON.stringify(lastRt, null, 2)}
            </pre>
          </div>
        )}
      </div>

      <div className="card">
        <strong>外脑关闭内脑</strong>
        <p style={{ fontSize: 12, color: '#8b92a8', margin: '6px 0 10px' }}>
          <code>POST /api/outer/workspace/{workspaceId}/shutdown</code>
        </p>
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="danger" disabled={shutdownBusy} onClick={() => void shutdown(false)}>
            仅休眠
          </button>
          <button type="button" disabled={shutdownBusy} onClick={() => void shutdown(true)}>
            晋升 manifest 后休眠
          </button>
        </div>
      </div>
    </div>
  );
}

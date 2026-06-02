/**
 * 内脑实况 UI（DyFlow）：mode / DAG / failure / node_results / 日志。
 */

import { formatWallClockTime } from '@utlra/chat-ir/serialize';

export type DyflowInspectorPayload = {
  engine: 'dyflow';
  state: { mode: string; burstId?: string } | null;
  dag: {
    nodeCount: number;
    nodes: Array<{ id: string; ref: string; instructionPreview: string }>;
  } | null;
  memory: {
    goal: string | null;
    factsCount: number;
    constraintsCount: number;
    lastFailure: {
      summary: string;
      transient?: boolean;
      localRef?: string;
      nodeInstId?: string;
    } | null;
    nodeResults: Array<{ id: string; ref: string; ok: boolean }>;
  } | null;
  localNodes: Array<{ id: string; kind: string; description: string }>;
};

export type BrainInspector = {
  engine?: 'dyflow' | 'legacy';
  dyflow?: DyflowInspectorPayload | null;
  goalText: string;
  paths: { brainDir: boolean };
  logHighlights?: {
    lastDyflowTickStart?: { ts?: unknown; data?: unknown } | null;
    lastBaseNode?: { ts?: unknown; event?: unknown; data?: unknown } | null;
    lastDesigner?: { ts?: unknown; event?: unknown; data?: unknown } | null;
  };
  dyflowTickExplained?: { summary: string; modes: Array<{ mode: string; what: string }> };
};

export type PiLogsResponse = {
  entries: Record<string, unknown>[];
  source: string | null;
  hint?: string;
  count?: number;
};

const DYFLOW_LOG_MODULES = new Set([
  'dyflow-controller',
  'designer',
  'base-node',
  'runner',
  'node-creator',
  'node-assembler',
  'node-abstractor',
]);

/** 将 DyFlow 相关 Logger JSON 行译为简短中文 */
export function describePiLogEntry(e: Record<string, unknown>): string {
  if (e['_parseError']) return '（日志行解析失败）';
  const mod = String(e['module'] ?? '');
  const ev = String(e['event'] ?? '');
  const data = e['data'] as Record<string, unknown> | undefined;

  if (!DYFLOW_LOG_MODULES.has(mod)) {
    return mod ? `（旧引擎日志 · 已忽略）${mod} · ${ev}` : JSON.stringify(e).slice(0, 80);
  }

  if (mod === 'dyflow-controller' && ev === 'tick.start') {
    return `DyFlow：tick（${String(data?.['mode'] ?? '?')}）`;
  }
  if (mod === 'designer') {
    if (ev === 'design.committed') return 'Designer：已提交 local_dag';
    if (ev === 'design.done') return 'Designer：宣告完成';
    if (ev === 'design.start') return 'Designer：规划中…';
    if (ev === 'design.giveup') return 'Designer：放弃本轮规划';
  }
  if (mod === 'base-node') {
    if (ev === 'start') return `baseNode：开始（${String(data?.['nodeInstId'] ?? '')}）`;
    if (ev === 'done') return `baseNode：完成（${data?.['rounds'] ?? '?'} 轮）`;
    if (ev === 'fail_fast') return 'baseNode：连续无进展，上交 Designer';
    if (ev === 'safety_cap') return 'baseNode：达到轮次上限';
    if (ev === 'terminal_failure') return 'baseNode：CANNOT_CONTINUE';
  }
  if (mod === 'runner' && ev.includes('run')) return `Runner：${ev}`;

  return `${mod} · ${ev}`;
}

function dyflowModeClass(mode: string): string {
  return ['DESIGN', 'RUN', 'AWAITING', 'DONE'].includes(mode) ? mode : 'unknown';
}

function DyflowLiveSection({
  dyflow,
  brain,
  lastHuman,
}: {
  dyflow: DyflowInspectorPayload;
  brain: BrainInspector;
  lastHuman: string;
}) {
  const mode = dyflow.state?.mode ?? '—';
  const mem = dyflow.memory;
  const lh = brain.logHighlights;
  const explained = brain.dyflowTickExplained;

  return (
    <>
      <div className="inner-live-mode-strip">
        <div className={`pi-mode pi-mode-${dyflowModeClass(mode)}`}>DyFlow · {mode}</div>
        {dyflow.state?.burstId && (
          <span className="inner-live-muted inline">burst {dyflow.state.burstId}</span>
        )}
      </div>

      <div className="inner-live-section-title">当前进度（日志）</div>
      <div className="inner-live-current-big">{lastHuman}</div>

      <div className="inner-live-section-title" style={{ marginTop: 14 }}>
        当前 DAG
      </div>
      {dyflow.dag && dyflow.dag.nodes.length > 0 ? (
        <div className="inner-live-ms inner-live-ms-prominent">
          {dyflow.dag.nodes.map((n) => (
            <div key={n.id} className="inner-live-ms-row ms-Pending">
              <div className="inner-live-ms-row-head">
                <span className="inner-live-ms-id">{n.id}</span>
                <code style={{ fontSize: 10, marginRight: 6 }}>{n.ref}</code>
              </div>
              {n.instructionPreview && (
                <pre style={{ fontSize: 11, margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>
                  {n.instructionPreview}
                </pre>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="inner-live-muted">尚无 local_dag（DESIGN 阶段或未 commit）</div>
      )}

      <div className="inner-live-section-title" style={{ marginTop: 14 }}>
        last_failure
      </div>
      {mem?.lastFailure ? (
        <div className="inner-live-attr inner-live-attr-prominent">
          <code>{mem.lastFailure.localRef ?? '—'}</code>
          {mem.lastFailure.transient && <span className="inner-live-replan inline">transient</span>}
          <pre>{mem.lastFailure.summary}</pre>
        </div>
      ) : (
        <div className="inner-live-muted">（无）</div>
      )}

      <div className="inner-live-section-title" style={{ marginTop: 14 }}>
        node_results（{mem?.nodeResults.length ?? 0}）
      </div>
      <div className="inner-live-ms">
        {(mem?.nodeResults ?? []).length === 0 ? (
          <div className="inner-live-muted">尚无完成节点</div>
        ) : (
          mem!.nodeResults.map((r) => (
            <div key={r.id} className={`inner-live-ms-row ms-${r.ok ? 'Completed' : 'Active'}`}>
              <span className="inner-live-ms-id">{r.id}</span>
              <code style={{ fontSize: 10 }}>{r.ref}</code>
              <span style={{ marginLeft: 8 }}>{r.ok ? '✓ ok' : '✗'}</span>
            </div>
          ))
        )}
      </div>

      <div className="inner-live-section-title" style={{ marginTop: 14 }}>
        LocalNode 库（{dyflow.localNodes.length}）
      </div>
      <div className="inner-live-ms" style={{ maxHeight: 160, overflowY: 'auto' }}>
        {dyflow.localNodes.length === 0 ? (
          <div className="inner-live-muted">尚无 LocalNode（首次 spawn 会 seed preset）</div>
        ) : (
          dyflow.localNodes.map((n) => (
            <div key={n.id} className="inner-live-ms-row ms-Pending">
              <code style={{ fontSize: 10 }}>{n.id}</code>
              <span className="inner-live-ms-title">{n.description || n.kind}</span>
            </div>
          ))
        )}
      </div>

      <div className="inner-live-section-title" style={{ marginTop: 14 }}>
        Goal / memory
      </div>
      <div className="inner-live-muted">
        facts {mem?.factsCount ?? 0} · constraints {mem?.constraintsCount ?? 0}
      </div>
      <pre className="inner-live-goal inner-live-goal-prominent">
        {(mem?.goal ?? brain.goalText)?.trim()?.slice(0, 1200) || '（空）'}
      </pre>

      {lh?.lastDesigner && (
        <>
          <div className="inner-live-section-title" style={{ marginTop: 12 }}>
            最近 Designer
          </div>
          <div className="inner-live-muted">
            {String(lh.lastDesigner.event ?? '')}
            {lh.lastDesigner.ts != null
              ? ` · ${formatWallClockTime(String(lh.lastDesigner.ts), { compactToday: false })}`
              : ''}
          </div>
        </>
      )}
      {lh?.lastBaseNode && (
        <>
          <div className="inner-live-section-title" style={{ marginTop: 8 }}>
            最近 baseNode
          </div>
          <div className="inner-live-muted">
            {String(lh.lastBaseNode.event ?? '')}
            {lh.lastBaseNode.ts != null
              ? ` · ${formatWallClockTime(String(lh.lastBaseNode.ts), { compactToday: false })}`
              : ''}
          </div>
        </>
      )}

      {explained && (
        <details className="inner-live-details inner-live-tech" style={{ marginTop: 12 }}>
          <summary>DyFlow 说明</summary>
          <p className="inner-live-details-summary">{explained.summary}</p>
          <ul className="inner-live-details-modes">
            {explained.modes.map((row) => (
              <li key={row.mode}>
                <strong>{row.mode}</strong> — {row.what}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function pickLastDyflowLogHuman(entries: Record<string, unknown>[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    const mod = String(e['module'] ?? '');
    if (DYFLOW_LOG_MODULES.has(mod)) return describePiLogEntry(e);
  }
  return '（尚无 DyFlow 运行日志）';
}

export function InnerLiveDeck({
  brain,
  logs,
  piBusy,
  insightLoading = false,
}: {
  brain: BrainInspector | null;
  logs: PiLogsResponse | null;
  piBusy: boolean;
  insightLoading?: boolean;
}) {
  const dyflow = brain?.dyflow;
  const hasDyflow = brain?.engine === 'dyflow' && dyflow;
  const entries = (logs?.entries ?? []).filter((raw) => {
    const mod = String((raw as Record<string, unknown>)['module'] ?? '');
    return !mod || DYFLOW_LOG_MODULES.has(mod);
  });
  const lastHuman = pickLastDyflowLogHuman(entries);

  return (
    <div className="card inner-live">
      <div className="inner-live-title-row">
        <strong className="inner-live-title">内脑实况</strong>
        <span className="inner-live-title-tag">DyFlow</span>
      </div>
      {insightLoading && <div className="inner-live-loading">正在拉取状态…</div>}
      <p className="inner-live-hint inner-live-hint-short">
        DESIGN / RUN / AWAITING / DONE；DAG、失败与节点结果。底部可展开 DyFlow 日志。
      </p>

      <div className="inner-live-toolbar">
        {piBusy && <span className="inner-live-pulse">Pi-mono 运行中</span>}
        {!brain?.paths.brainDir && <span className="inner-live-warn">尚无 .brain 数据</span>}
        {brain && !hasDyflow && (
          <span className="inner-live-warn">尚无 dyflow-state（先 spawn 内脑或点 Pi-mono 单步）</span>
        )}
      </div>

      <div className="inner-live-core-flow">
        {hasDyflow ? (
          <DyflowLiveSection dyflow={dyflow!} brain={brain!} lastHuman={lastHuman} />
        ) : (
          <div className="inner-live-muted">等待 DyFlow 工作区状态…</div>
        )}
      </div>

      <details className="inner-live-details inner-live-logs-fold">
        <summary>
          DyFlow 运行日志（JSONL，{entries.length} 条）— 已过滤旧三件套日志
        </summary>
        <div className="inner-live-log-meta">
          {logs?.source ? <code>{logs.source}</code> : logs?.hint ?? '—'}
        </div>
        <div className="inner-live-entries inner-live-entries-contained">
          {entries.length === 0 ? (
            <div className="inner-live-muted">无 DyFlow 日志</div>
          ) : (
            entries.map((raw, i) => {
              const e = raw as Record<string, unknown>;
              const level = String(e['level'] ?? 'info');
              const ts = e['ts'] ? new Date(String(e['ts'])).toLocaleTimeString() : '';
              return (
                <div key={i} className={`inner-live-entry log-${level}`}>
                  <div className="inner-live-entry-head">
                    <span className="inner-live-lvl">{level}</span>
                    <span className="inner-live-ts">{ts}</span>
                    <span className="inner-live-mod">{String(e['module'] ?? '')}</span>
                    <span className="inner-live-ev">{String(e['event'] ?? '')}</span>
                  </div>
                  <div className="inner-live-muted" style={{ fontSize: 11, marginTop: 4 }}>
                    {describePiLogEntry(e)}
                  </div>
                  {e['data'] !== undefined && (
                    <pre className="inner-live-data">{JSON.stringify(e['data'], null, 2)}</pre>
                  )}
                </div>
              );
            })
          )}
        </div>
      </details>
    </div>
  );
}

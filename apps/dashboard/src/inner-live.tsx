/**
 * 内脑实况 UI（DyFlow）：mode / 执行 graph / failure / 日志。
 */

import { formatWallClockTime } from '@utlra/chat-ir/serialize';
import { BurstExecGraph, type ExecGraphEdge, type ExecGraphNode } from './burst-exec-graph.js';

export type DagNodeExecStatus = 'pending' | 'active' | 'ok' | 'fail';

export type DyflowInspectorPayload = {
  engine: 'dyflow';
  state: { mode: string; burstId?: string } | null;
  dag: {
    nodeCount: number;
    entry?: string;
    impliedEdges?: boolean;
    nodes: Array<{
      id: string;
      ref: string;
      instructionPreview: string;
      status?: DagNodeExecStatus;
      milestone?: string;
    }>;
    edges?: Array<{ from: string; to: string }>;
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
  workflowRun?: {
    workflowId: string;
    version: string;
    ok: boolean;
    abortedAt?: string;
    steps: Array<{
      stepId: string;
      ok: boolean;
      attempts: number;
      detailPreview?: string;
    }>;
  } | null;
};

export type BrainInspector = {
  engine?: 'dyflow' | 'legacy' | 'execute';
  dyflow?: DyflowInspectorPayload | null;
  /** execute 模式（无 dyflow-state）也会挂在这里 */
  workflowRun?: DyflowInspectorPayload['workflowRun'];
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

function dagToGraph(dag: NonNullable<DyflowInspectorPayload['dag']>): {
  nodes: ExecGraphNode[];
  edges: ExecGraphEdge[];
  footnote?: string;
} {
  const nodes: ExecGraphNode[] = dag.nodes.map((n) => ({
    id: n.id,
    label: n.ref,
    sublabel: n.instructionPreview || undefined,
    status: n.status ?? 'pending',
  }));
  let edges: ExecGraphEdge[] =
    dag.edges && dag.edges.length > 0
      ? dag.edges.map((e) => ({ from: e.from, to: e.to }))
      : [];
  if (edges.length === 0 && nodes.length > 1) {
    edges = nodes.slice(0, -1).map((n, i) => ({ from: n.id, to: nodes[i + 1]!.id }));
  }
  return {
    nodes,
    edges,
    footnote: dag.impliedEdges
      ? '边为 nodes[] 顺序隐含串行（磁盘未写 edges）'
      : dag.entry
        ? `entry=${dag.entry}`
        : undefined,
  };
}

function workflowToGraph(wr: NonNullable<DyflowInspectorPayload['workflowRun']>): {
  nodes: ExecGraphNode[];
  edges: ExecGraphEdge[];
} {
  const nodes: ExecGraphNode[] = wr.steps.map((s) => ({
    id: s.stepId,
    label: s.ok ? `ok · ${s.attempts}×` : `fail · ${s.attempts}×`,
    sublabel: s.detailPreview,
    status: s.ok ? 'ok' : 'fail',
  }));
  const edges: ExecGraphEdge[] = nodes
    .slice(0, -1)
    .map((n, i) => ({ from: n.id, to: nodes[i + 1]!.id }));
  return { nodes, edges };
}

function ExecuteLiveSection({
  workflowRun,
  goalText,
}: {
  workflowRun: NonNullable<DyflowInspectorPayload['workflowRun']>;
  goalText: string;
}) {
  const ewGraph = workflowToGraph(workflowRun);
  return (
    <>
      <div className="inner-live-mode-strip">
        <div className="pi-mode pi-mode-DONE">Execute · EW</div>
        <span className={`inner-live-muted inline ${workflowRun.ok ? 'burst-ew-ok' : 'burst-ew-fail'}`}>
          {workflowRun.workflowId}@{workflowRun.version} {workflowRun.ok ? '✓' : '✗'}
        </span>
      </div>
      <BurstExecGraph
        title={`Executable Workflow · ${workflowRun.workflowId}@${workflowRun.version}`}
        nodes={ewGraph.nodes}
        edges={ewGraph.edges}
        footnote={
          workflowRun.abortedAt
            ? `abortedAt=${workflowRun.abortedAt}`
            : workflowRun.ok
              ? '全部 step expect 通过'
              : '存在失败 step'
        }
      />
      <div className="inner-live-section-title" style={{ marginTop: 14 }}>
        Goal
      </div>
      <pre className="inner-live-goal inner-live-goal-prominent">
        {goalText?.trim()?.slice(0, 1200) || '（空）'}
      </pre>
    </>
  );
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
  const dagGraph = dyflow.dag ? dagToGraph(dyflow.dag) : null;
  const wr = dyflow.workflowRun ?? brain.workflowRun ?? null;
  const ewGraph = wr ? workflowToGraph(wr) : null;
  const done = dagGraph?.nodes.filter((n) => n.status === 'ok').length ?? 0;
  const total = dagGraph?.nodes.length ?? 0;

  return (
    <>
      <div className="inner-live-mode-strip">
        <div className={`pi-mode pi-mode-${dyflowModeClass(mode)}`}>DyFlow · {mode}</div>
        {dyflow.state?.burstId && (
          <span className="inner-live-muted inline">burst {dyflow.state.burstId}</span>
        )}
        {total > 0 && (
          <span className="inner-live-muted inline">
            DAG {done}/{total}
          </span>
        )}
        {wr && (
          <span className={`inner-live-muted inline ${wr.ok ? 'burst-ew-ok' : 'burst-ew-fail'}`}>
            EW {wr.workflowId}@{wr.version} {wr.ok ? '✓' : '✗'}
          </span>
        )}
      </div>

      <div className="inner-live-section-title">当前进度（日志）</div>
      <div className="inner-live-current-big">{lastHuman}</div>

      {ewGraph && wr && (
        <BurstExecGraph
          title={`Executable Workflow · ${wr.workflowId}@${wr.version}`}
          nodes={ewGraph.nodes}
          edges={ewGraph.edges}
          footnote={
            wr.abortedAt
              ? `abortedAt=${wr.abortedAt}`
              : wr.ok
                ? '全部 step expect 通过'
                : '存在失败 step'
          }
        />
      )}

      {dagGraph ? (
        <BurstExecGraph
          title="Burst 执行图（local_dag）"
          nodes={dagGraph.nodes}
          edges={dagGraph.edges}
          footnote={dagGraph.footnote}
        />
      ) : (
        <>
          <div className="inner-live-section-title" style={{ marginTop: 14 }}>
            Burst 执行图
          </div>
          <div className="inner-live-muted">尚无 local_dag（DESIGN 阶段或未 commit）</div>
        </>
      )}

      <div className="inner-live-section-title" style={{ marginTop: 14 }}>
        last_failure
      </div>
      {mem?.lastFailure ? (
        <div className="inner-live-attr inner-live-attr-prominent">
          <code>{mem.lastFailure.localRef ?? '—'}</code>
          {mem.lastFailure.nodeInstId && (
            <span className="inner-live-muted inline"> @ {mem.lastFailure.nodeInstId}</span>
          )}
          {mem.lastFailure.transient && <span className="inner-live-replan inline">transient</span>}
          <pre>{mem.lastFailure.summary}</pre>
        </div>
      ) : (
        <div className="inner-live-muted">（无）</div>
      )}

      <details className="inner-live-details" style={{ marginTop: 12 }}>
        <summary>node_results（{mem?.nodeResults.length ?? 0}）</summary>
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
      </details>

      <details className="inner-live-details" style={{ marginTop: 8 }}>
        <summary>LocalNode 库（{dyflow.localNodes.length}）</summary>
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
      </details>

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
  const workflowRun = brain?.workflowRun ?? dyflow?.workflowRun ?? null;
  const hasExecute = brain?.engine === 'execute' && workflowRun;
  const entries = (logs?.entries ?? []).filter((raw) => {
    const mod = String((raw as Record<string, unknown>)['module'] ?? '');
    return !mod || DYFLOW_LOG_MODULES.has(mod);
  });
  const lastHuman = pickLastDyflowLogHuman(entries);

  return (
    <div className="card inner-live">
      <div className="inner-live-title-row">
        <strong className="inner-live-title">内脑 Burst</strong>
        <span className="inner-live-title-tag">执行图</span>
      </div>
      {insightLoading && <div className="inner-live-loading">正在拉取状态…</div>}
      <p className="inner-live-hint inner-live-hint-short">
        主视图：DyFlow local_dag / EW steps 拓扑；节点色 = pending / active / ok / fail。
      </p>

      <div className="inner-live-toolbar">
        {piBusy && <span className="inner-live-pulse">Pi-mono 运行中</span>}
        {!brain?.paths.brainDir && <span className="inner-live-warn">尚无 .brain 数据</span>}
        {brain && !hasDyflow && !hasExecute && (
          <span className="inner-live-warn">尚无 dyflow-state / workflow_run（先 spawn 或跑 EW）</span>
        )}
      </div>

      <div className="inner-live-core-flow">
        {hasDyflow ? (
          <DyflowLiveSection dyflow={dyflow!} brain={brain!} lastHuman={lastHuman} />
        ) : hasExecute ? (
          <ExecuteLiveSection workflowRun={workflowRun!} goalText={brain?.goalText ?? ''} />
        ) : (
          <div className="inner-live-muted">等待 DyFlow / Executable Workflow 状态…</div>
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

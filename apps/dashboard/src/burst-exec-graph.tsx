/**
 * Burst 执行图：DyFlow DAG / Executable Workflow steps（纯 SVG，无额外依赖）
 * ADL: doc/structurizr/TASK-RUN-OBSERVABILITY.md §8
 */

export type GraphNodeStatus = 'pending' | 'active' | 'ok' | 'fail';

export type ExecGraphNode = {
  id: string;
  label: string;
  sublabel?: string;
  status: GraphNodeStatus;
};

export type ExecGraphEdge = { from: string; to: string };

const STATUS_FILL: Record<GraphNodeStatus, string> = {
  pending: '#2a3142',
  active: '#3d2f14',
  ok: '#143528',
  fail: '#3a1a1a',
};

const STATUS_STROKE: Record<GraphNodeStatus, string> = {
  pending: '#64748b',
  active: '#fbbf24',
  ok: '#4ade80',
  fail: '#f87171',
};

const NODE_W = 168;
const NODE_H = 56;
const H_GAP = 48;
const V_GAP = 36;
const PAD = 24;

function layoutLayers(
  nodes: ExecGraphNode[],
  edges: ExecGraphEdge[],
): { pos: Map<string, { x: number; y: number; layer: number }>; width: number; height: number } {
  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const id of ids) {
    indeg.set(id, 0);
    adj.set(id, []);
  }
  for (const e of edges) {
    if (!idSet.has(e.from) || !idSet.has(e.to)) continue;
    adj.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }

  const layer = new Map<string, number>();
  const q = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  for (const id of q) layer.set(id, 0);
  const queue = [...q];
  while (queue.length) {
    const id = queue.shift()!;
    const L = layer.get(id) ?? 0;
    for (const nxt of adj.get(id) ?? []) {
      layer.set(nxt, Math.max(layer.get(nxt) ?? 0, L + 1));
      const d = (indeg.get(nxt) ?? 1) - 1;
      indeg.set(nxt, d);
      if (d === 0) queue.push(nxt);
    }
  }
  for (const id of ids) {
    if (!layer.has(id)) layer.set(id, 0);
  }

  const byLayer = new Map<number, string[]>();
  for (const id of ids) {
    const L = layer.get(id)!;
    if (!byLayer.has(L)) byLayer.set(L, []);
    byLayer.get(L)!.push(id);
  }
  const maxLayer = Math.max(0, ...layer.values());
  const maxInLayer = Math.max(1, ...[...byLayer.values()].map((xs) => xs.length));

  const pos = new Map<string, { x: number; y: number; layer: number }>();
  for (let L = 0; L <= maxLayer; L++) {
    const row = byLayer.get(L) ?? [];
    row.forEach((id, i) => {
      const yOff = ((maxInLayer - row.length) * (NODE_H + V_GAP)) / 2;
      pos.set(id, {
        layer: L,
        x: PAD + L * (NODE_W + H_GAP),
        y: PAD + yOff + i * (NODE_H + V_GAP),
      });
    });
  }

  return {
    pos,
    width: PAD * 2 + (maxLayer + 1) * NODE_W + maxLayer * H_GAP,
    height: PAD * 2 + maxInLayer * NODE_H + (maxInLayer - 1) * V_GAP,
  };
}

function edgePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
): string {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
}

export function BurstExecGraph({
  title,
  nodes,
  edges,
  footnote,
}: {
  title: string;
  nodes: ExecGraphNode[];
  edges: ExecGraphEdge[];
  footnote?: string;
}) {
  if (nodes.length === 0) {
    return (
      <div className="burst-graph-empty">
        <div className="inner-live-section-title">{title}</div>
        <div className="inner-live-muted">尚无执行图</div>
      </div>
    );
  }

  const { pos, width, height } = layoutLayers(nodes, edges);

  return (
    <div className="burst-graph">
      <div className="burst-graph-head">
        <div className="inner-live-section-title" style={{ margin: 0 }}>
          {title}
        </div>
        <div className="burst-graph-legend">
          <span className="burst-leg burst-leg-ok">ok</span>
          <span className="burst-leg burst-leg-active">active</span>
          <span className="burst-leg burst-leg-fail">fail</span>
          <span className="burst-leg burst-leg-pending">pending</span>
        </div>
      </div>
      <div className="burst-graph-scroll">
        <svg
          className="burst-graph-svg"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={title}
        >
          <defs>
            <marker
              id="burst-arrow"
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="3"
              orient="auto"
            >
              <path d="M0,0 L7,3 L0,6 Z" fill="#64748b" />
            </marker>
          </defs>
          {edges.map((e, i) => {
            const a = pos.get(e.from);
            const b = pos.get(e.to);
            if (!a || !b) return null;
            return (
              <path
                key={`${e.from}-${e.to}-${i}`}
                d={edgePath(a, b)}
                fill="none"
                stroke="#64748b"
                strokeWidth={1.5}
                markerEnd="url(#burst-arrow)"
                opacity={0.85}
              />
            );
          })}
          {nodes.map((n) => {
            const p = pos.get(n.id)!;
            return (
              <g key={n.id} transform={`translate(${p.x},${p.y})`}>
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={8}
                  fill={STATUS_FILL[n.status]}
                  stroke={STATUS_STROKE[n.status]}
                  strokeWidth={n.status === 'active' ? 2.5 : 1.5}
                />
                <text x={10} y={20} fill="#e2e8f0" fontSize={12} fontWeight={600}>
                  {n.id.length > 18 ? `${n.id.slice(0, 17)}…` : n.id}
                </text>
                <text x={10} y={38} fill="#94a3b8" fontSize={10}>
                  {(n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label) || '—'}
                </text>
                {n.sublabel && (
                  <title>{`${n.id}\n${n.label}\n${n.sublabel}`}</title>
                )}
                {!n.sublabel && <title>{`${n.id}\n${n.label}`}</title>}
              </g>
            );
          })}
        </svg>
      </div>
      {footnote && <div className="burst-graph-foot">{footnote}</div>}
      <div className="burst-graph-list">
        {nodes.map((n) => (
          <div key={n.id} className={`burst-graph-row burst-st-${n.status}`}>
            <code>{n.id}</code>
            <span className="burst-graph-row-ref">{n.label}</span>
            <span className="burst-graph-row-st">{n.status}</span>
            {n.sublabel && <span className="burst-graph-row-sub">{n.sublabel}</span>}
          </div>
        ))}
        {/* keep edges resolvable for a11y / debug */}
        {edges.length > 0 && (
          <div className="inner-live-muted" style={{ fontSize: 11, marginTop: 6 }}>
            edges: {edges.map((e) => `${e.from}→${e.to}`).join(' · ')}
          </div>
        )}
      </div>
    </div>
  );
}

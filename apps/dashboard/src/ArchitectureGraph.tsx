/**
 * ArchitectureGraph — 项目模块力导向节点图
 *
 * 节点 = 模块；边 = 数据/控制流向；颜色 = 所属层次
 * 悬停节点可见该模块的输入/输出说明
 */
import { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';

// ── 数据定义 ──────────────────────────────────────────────────────────────────

export type NodeLayer =
  | 'channel'   // 外部渠道（IM / 用户）
  | 'outer'     // 外脑层
  | 'inner'     // 内脑层（pi-mono）
  | 'storage'   // 存储层
  | 'llm'       // LLM API
  | 'tool';     // 工具

export interface ArchNode {
  id:       string;
  label:    string;
  layer:    NodeLayer;
  /** 模块简介 */
  desc:     string;
  /** 主要输入 */
  inputs:   string[];
  /** 主要输出 */
  outputs:  string[];
  /** 节点质量（影响半径）*/
  weight?:  number;
}

export interface ArchEdge {
  source: string;
  target: string;
  label?: string;
  style?: 'solid' | 'dashed';
}

const NODES: ArchNode[] = [
  {
    id: 'user', label: '用户', layer: 'channel',
    desc: '通过外部 IM（Discord 等）与系统交互的人类用户',
    inputs: ['键盘输入、图片'],
    outputs: ['Discord 消息'],
    weight: 1.5,
  },
  {
    id: 'discord-channel', label: 'Discord 渠道桥', layer: 'channel',
    desc: 'DiscordChannel：ChatIRChannel 的 Discord 实现。直接对接 Discord Gateway / REST，进程内落 chat IR store',
    inputs: ['Discord MESSAGE_CREATE', '外脑 postMessage'],
    outputs: ['inbound → 外脑', 'REST → Discord'],
    weight: 2,
  },
  {
    id: 'outer-brain', label: '外脑', layer: 'outer',
    desc: '总协调者：接收消息、LLM 决策、派发内脑任务、seed/merge 技能、回复用户',
    inputs: ['IM inbound', '内脑心跳/exit', '线程历史'],
    outputs: ['IM reply', '内脑 spawn', '技能 seed/merge'],
    weight: 4,
  },
  {
    id: 'inner-brain', label: '内脑', layer: 'inner',
    desc: '独立子进程，DECOMPOSE → EXECUTE → ATTRIBUTE 主循环，调工具与 LLM 完成任务',
    inputs: ['goal.md', '注入技能', 'LLM 响应', '工具结果'],
    outputs: ['deliverables', 'write_skill/knowledge/constraint', '状态快照'],
    weight: 4,
  },
  {
    id: 'tools', label: '工具集', layer: 'tool',
    desc: 'shell_exec · read/write_file · web_search · query_skills · write_skill 等',
    inputs: ['LLM tool_call 指令'],
    outputs: ['执行结果 → 内脑', '技能写入 drive9'],
    weight: 2,
  },
  {
    id: 'zhipu', label: 'Zhipu AI', layer: 'llm',
    desc: 'GLM-5.1 / glm-4-flashx / glm-5v-turbo，支持 function calling 与视觉理解',
    inputs: ['messages + tools schema'],
    outputs: ['content / tool_calls / reasoning'],
    weight: 2.5,
  },
  {
    id: 'drive9', label: 'drive9', layer: 'storage',
    desc: '执行轨知识桥梁（S/K/P）：内脑产出技能/知识写入，外脑 seed 时取出注入新内脑。原文存储不经 LLM 改写，vector+BM25 语义搜索。不用于外脑对话检索。',
    inputs: ['内脑写 S/K/P（PUT）', '内脑运行时查询（grep）', '外脑 seed 查询（grep）'],
    outputs: ['技能原文 → 内脑运行时', 'S/K/P → 外脑 seed 新内脑'],
    weight: 2.5,
  },
  {
    id: 'mem9', label: 'mem9', layer: 'storage',
    desc: '外脑语义记忆：存对话日志（外脑写）+ 任务发现/结论（内脑 write_memo 写）。外脑对话时语义召回，回答用户问题。',
    inputs: ['对话摘要（外脑写）', '任务发现/结论（内脑 write_memo 写）'],
    outputs: ['历史上下文 → 外脑', '任务发现 → 外脑回答用户'],
    weight: 2,
  },
  {
    id: 'local-mem', label: '内脑记忆', layer: 'storage',
    desc: '内脑本地文件记忆：daily-*.md 每日日志 + TASKS.md；独立于外脑，任务结束后留档',
    inputs: ['内脑 appendDailyLog', 'writeTasks'],
    outputs: ['readDailyLog → 内脑上下文', 'readTasks → 规划参考'],
    weight: 1.5,
  },
];

const EDGES: ArchEdge[] = [
  // 用户 ↔ Discord 渠道桥 ↔ 外脑
  { source: 'user',             target: 'discord-channel', label: '发消息' },
  { source: 'discord-channel',  target: 'outer-brain',     label: 'inbound (ChatIRInboundEvent)' },
  { source: 'outer-brain',      target: 'discord-channel', label: 'postMessage', style: 'dashed' },

  // 外脑 ↔ 内脑（控制流）
  { source: 'outer-brain', target: 'inner-brain', label: 'spawn + seed 技能' },
  { source: 'inner-brain', target: 'outer-brain', label: '心跳 / exit', style: 'dashed' },

  // LLM
  { source: 'outer-brain', target: 'zhipu',       label: 'LLM 回复' },
  { source: 'inner-brain', target: 'zhipu',       label: 'LLM 推理' },

  // 内脑工具执行
  { source: 'inner-brain', target: 'tools',       label: 'tool_call' },
  { source: 'tools',       target: 'inner-brain', label: '执行结果', style: 'dashed' },

  // 内脑 → drive9（产出知识）
  { source: 'inner-brain', target: 'drive9',      label: '写 S/K（产出）' },
  // 内脑 ← drive9（运行中查技能）
  { source: 'drive9',      target: 'inner-brain', label: '查技能', style: 'dashed' },

  // 外脑 ← drive9（仅用于 seed 新任务，不用于对话）
  { source: 'drive9',      target: 'outer-brain', label: 'seed 技能', style: 'dashed' },
  // 外脑 → drive9（任务结束后 merge 内脑产出的 S/K/P）
  { source: 'outer-brain', target: 'drive9',      label: 'merge S/K/P' },
  // 内脑 → mem9（任务发现/结论直接写入外脑记忆）
  { source: 'inner-brain', target: 'mem9',        label: 'write_memo 发现/结论' },

  // 外脑 ↔ mem9（对话记忆，内脑不可见）
  { source: 'outer-brain', target: 'mem9',        label: '写对话/任务' },
  { source: 'mem9',        target: 'outer-brain', label: '历史召回', style: 'dashed' },

  // 内脑 ↔ 本地记忆（任务内独立）
  { source: 'inner-brain', target: 'local-mem',   label: '写日志' },
  { source: 'local-mem',   target: 'inner-brain', label: '读上下文', style: 'dashed' },
];

// ── 样式配置 ─────────────────────────────────────────────────────────────────

const LAYER_COLOR: Record<NodeLayer, string> = {
  channel: '#f59e0b',
  outer:   '#818cf8',
  inner:   '#34d399',
  storage: '#22d3ee',
  llm:     '#f472b6',
  tool:    '#a78bfa',
};

const LAYER_LABEL: Record<NodeLayer, string> = {
  channel: '渠道',
  outer:   '外脑',
  inner:   '内脑',
  storage: '存储',
  llm:     'LLM',
  tool:    '工具',
};

// ── 组件 ─────────────────────────────────────────────────────────────────────

interface TooltipState {
  node: ArchNode;
  x: number;
  y: number;
}

export function ArchitectureGraph() {
  const svgRef   = useRef<SVGSVGElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const simRef   = useRef<d3.Simulation<ArchNode & d3.SimulationNodeDatum, undefined> | null>(null);

  useEffect(() => {
    const svg = d3.select(svgRef.current!);
    svg.selectAll('*').remove();

    const width  = svgRef.current!.clientWidth  || 900;
    const height = svgRef.current!.clientHeight || 700;

    // ── SVG 滤镜（发光效果）
    const defs = svg.append('defs');

    // 通用发光滤镜
    const glowFilter = defs.append('filter').attr('id', 'glow').attr('x', '-50%').attr('y', '-50%').attr('width', '200%').attr('height', '200%');
    glowFilter.append('feGaussianBlur').attr('stdDeviation', '4').attr('result', 'blur');
    const gMerge = glowFilter.append('feMerge');
    gMerge.append('feMergeNode').attr('in', 'blur');
    gMerge.append('feMergeNode').attr('in', 'SourceGraphic');

    // 强发光（hover）
    const glowStrong = defs.append('filter').attr('id', 'glow-strong').attr('x', '-80%').attr('y', '-80%').attr('width', '260%').attr('height', '260%');
    glowStrong.append('feGaussianBlur').attr('stdDeviation', '10').attr('result', 'blur');
    const gsMerge = glowStrong.append('feMerge');
    gsMerge.append('feMergeNode').attr('in', 'blur');
    gsMerge.append('feMergeNode').attr('in', 'SourceGraphic');

    // 球面径向渐变（每种颜色一个）
    const layers = [...new Set(NODES.map((n) => n.layer))] as NodeLayer[];
    layers.forEach((layer) => {
      const color = LAYER_COLOR[layer];
      const grad = defs.append('radialGradient')
        .attr('id', `sphere-${layer}`)
        .attr('cx', '35%').attr('cy', '30%')
        .attr('r', '65%');
      grad.append('stop').attr('offset', '0%')
        .attr('stop-color', '#ffffff').attr('stop-opacity', 0.55);
      grad.append('stop').attr('offset', '40%')
        .attr('stop-color', color).attr('stop-opacity', 0.9);
      grad.append('stop').attr('offset', '100%')
        .attr('stop-color', color).attr('stop-opacity', 0.25);
    });

    // 箭头 marker
    NODES.forEach((n) => {
      defs.append('marker')
        .attr('id', `arrow-${n.layer}`)
        .attr('viewBox', '0 -4 8 8')
        .attr('refX', 8)
        .attr('refY', 0)
        .attr('markerWidth', 6)
        .attr('markerHeight', 6)
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M0,-4L8,0L0,4')
        .attr('fill', LAYER_COLOR[n.layer])
        .attr('opacity', 0.7);
    });
    defs.append('marker')
      .attr('id', 'arrow-default')
      .attr('viewBox', '0 -4 8 8').attr('refX', 8).attr('refY', 0)
      .attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto')
      .append('path').attr('d', 'M0,-4L8,0L0,4').attr('fill', '#4b5563').attr('opacity', 0.8);

    // ── 缩放容器
    const root = svg.append('g').attr('class', 'root');
    svg.call(
      d3.zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.2, 4])
        .on('zoom', (e) => root.attr('transform', e.transform)),
    );

    // ── 准备数据
    const nodeMap = new Map<string, ArchNode>(NODES.map((n) => [n.id, n]));
    type SimNode = ArchNode & d3.SimulationNodeDatum;
    const simNodes: SimNode[] = NODES.map((n) => ({ ...n }));

    type SimEdge = d3.SimulationLinkDatum<SimNode> & { label?: string; style?: 'solid' | 'dashed'; origSource: string };
    const simEdges: SimEdge[] = EDGES.map((e) => ({
      label: e.label,
      style: e.style,
      origSource: e.source,
      source: simNodes.find((n) => n.id === e.source)!,
      target: simNodes.find((n) => n.id === e.target)!,
    }));

    // ── 边
    const edgeGroup = root.append('g').attr('class', 'edges');
    const edgePaths = edgeGroup
      .selectAll('path')
      .data(simEdges)
      .join('path')
      .attr('fill', 'none')
      .attr('stroke', (e) => {
        const src = nodeMap.get(e.origSource);
        return src ? LAYER_COLOR[src.layer] : '#4b5563';
      })
      .attr('stroke-opacity', 0.35)
      .attr('stroke-width', 1.2)
      .attr('stroke-dasharray', (e) => e.style === 'dashed' ? '5,4' : null)
      .attr('marker-end', (e) => {
        const src = nodeMap.get(e.origSource);
        return src ? `url(#arrow-${src.layer})` : 'url(#arrow-default)';
      });

    // 边标签
    const edgeLabels = root.append('g').attr('class', 'edge-labels')
      .selectAll('text')
      .data(simEdges.filter((e) => e.label))
      .join('text')
      .attr('font-size', 9)
      .attr('fill', '#6b7280')
      .attr('text-anchor', 'middle')
      .text((e) => e.label ?? '');

    // ── 节点
    const nodeGroup = root.append('g').attr('class', 'nodes');
    const nodeGs = nodeGroup
      .selectAll<SVGGElement, SimNode>('g')
      .data(simNodes)
      .join('g')
      .attr('cursor', 'pointer')
      .call(
        d3.drag<SVGGElement, SimNode>()
          .on('start', (event, d) => {
            if (!event.active) sim.alphaTarget(0.3).restart();
            d.fx = d.x; d.fy = d.y;
          })
          .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
          .on('end', (event, d) => {
            if (!event.active) sim.alphaTarget(0);
            d.fx = null; d.fy = null;
          }),
      );

    // 节点外圈（大光晕）
    nodeGs.append('circle')
      .attr('r', (d) => nodeRadius(d) + 12)
      .attr('fill', (d) => LAYER_COLOR[d.layer])
      .attr('opacity', 0.06)
      .attr('filter', 'url(#glow)');

    // 节点主体（球面渐变）
    nodeGs.append('circle')
      .attr('r', nodeRadius)
      .attr('fill', (d) => `url(#sphere-${d.layer})`)
      .attr('stroke', (d) => LAYER_COLOR[d.layer])
      .attr('stroke-width', 1.2)
      .attr('stroke-opacity', 0.6)
      .attr('filter', 'url(#glow)');

    // 高光小点（球面反光）
    nodeGs.append('circle')
      .attr('r', (d) => nodeRadius(d) * 0.22)
      .attr('cx', (d) => -nodeRadius(d) * 0.28)
      .attr('cy', (d) => -nodeRadius(d) * 0.28)
      .attr('fill', '#ffffff')
      .attr('opacity', 0.45)
      .attr('pointer-events', 'none');

    // 节点标签（写在球内）
    nodeGs.each(function (d) {
      const g = d3.select(this);
      const lines = d.label.split('\n');
      const lineH = 14;
      const totalH = lines.length * lineH;
      lines.forEach((line, i) => {
        g.append('text')
          .attr('text-anchor', 'middle')
          .attr('dominant-baseline', 'middle')
          .attr('y', i * lineH - totalH / 2 + lineH / 2)
          .attr('font-size', 11)
          .attr('font-weight', 600)
          .attr('fill', '#ffffff')
          .attr('opacity', 0.92)
          .attr('pointer-events', 'none')
          .text(line);
      });
    });

    // ── 交互
    nodeGs
      .on('mouseenter', function (event, d) {
        d3.select(this).select('circle:nth-child(2)')
          .attr('stroke-opacity', 1)
          .attr('stroke-width', 2.5)
          .attr('filter', 'url(#glow-strong)');
        const rect = svgRef.current!.getBoundingClientRect();
        setTooltip({ node: d, x: event.clientX - rect.left, y: event.clientY - rect.top });
        // 高亮相关边
        edgePaths.attr('stroke-opacity', (e) => {
          const s = (e.source as SimNode).id;
          const t = (e.target as SimNode).id;
          return (s === d.id || t === d.id) ? 0.9 : 0.1;
        });
      })
      .on('mouseleave', function () {
        d3.select(this).select('circle:nth-child(2)')
          .attr('stroke-opacity', 0.6)
          .attr('stroke-width', 1.2)
          .attr('filter', 'url(#glow)');
        setTooltip(null);
        edgePaths.attr('stroke-opacity', 0.35);
      });

    // ── 力模拟
    const sim = d3.forceSimulation<SimNode>(simNodes)
      .force('link', d3.forceLink<SimNode, SimEdge>(simEdges).distance(180).strength(0.3))
      .force('charge', d3.forceManyBody().strength(-900))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collide', d3.forceCollide<SimNode>().radius((d) => nodeRadius(d) + 30))
      .on('tick', () => {
        edgePaths.attr('d', (e) => {
          const s = e.source as SimNode;
          const t = e.target as SimNode;
          const dx = (t.x ?? 0) - (s.x ?? 0);
          const dy = (t.y ?? 0) - (s.y ?? 0);
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const rs = nodeRadius(s);
          const rt = nodeRadius(t) + 8;
          const sx = (s.x ?? 0) + (dx / dist) * rs;
          const sy = (s.y ?? 0) + (dy / dist) * rs;
          const tx = (t.x ?? 0) - (dx / dist) * rt;
          const ty = (t.y ?? 0) - (dy / dist) * rt;
          const cx = (sx + tx) / 2 - dy * 0.2;
          const cy = (sy + ty) / 2 + dx * 0.2;
          return `M${sx},${sy} Q${cx},${cy} ${tx},${ty}`;
        });

        edgeLabels
          .attr('x', (e) => {
            const s = e.source as SimNode;
            const t = e.target as SimNode;
            return ((s.x ?? 0) + (t.x ?? 0)) / 2;
          })
          .attr('y', (e) => {
            const s = e.source as SimNode;
            const t = e.target as SimNode;
            const dx = (t.x ?? 0) - (s.x ?? 0);
            return ((s.y ?? 0) + (t.y ?? 0)) / 2 + dx * 0.1;
          });

        nodeGs.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
      });

    simRef.current = sim;
    return () => { sim.stop(); };
  }, []);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#06070f', borderRadius: 8, overflow: 'hidden' }}>
      {/* 图例 */}
      <div style={{
        position: 'absolute', top: 12, left: 12, zIndex: 10,
        display: 'flex', flexDirection: 'column', gap: 5, background: 'rgba(0,0,0,0.6)',
        padding: '10px 14px', borderRadius: 8, backdropFilter: 'blur(4px)',
      }}>
        <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2 }}>图层说明</div>
        {(Object.entries(LAYER_LABEL) as [NodeLayer, string][]).map(([layer, name]) => (
          <div key={layer} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
            <div style={{
              width: 10, height: 10, borderRadius: '50%',
              background: LAYER_COLOR[layer],
              boxShadow: `0 0 6px ${LAYER_COLOR[layer]}`,
            }} />
            <span style={{ color: '#d1d5db' }}>{name}</span>
          </div>
        ))}
        <div style={{ marginTop: 6, fontSize: 10, color: '#4b5563' }}>
          滚轮缩放 · 拖拽平移 · 节点可拖动
        </div>
      </div>

      {/* 标题 */}
      <div style={{
        position: 'absolute', top: 12, right: 16, zIndex: 10,
        fontSize: 13, color: '#374151',
        fontVariantNumeric: 'tabular-nums',
      }}>
        {NODES.length} 个模块 · {EDGES.length} 条数据流
      </div>

      {/* 主画布 */}
      <svg ref={svgRef} style={{ width: '100%', height: '100%', display: 'block' }} />

      {/* Hover 详情面板 */}
      {tooltip && (
        <div style={{
          position: 'absolute',
          left: Math.min(tooltip.x + 16, (svgRef.current?.clientWidth ?? 900) - 280),
          top:  Math.min(tooltip.y - 10, (svgRef.current?.clientHeight ?? 700) - 220),
          zIndex: 20,
          width: 260,
          background: 'rgba(10,12,25,0.95)',
          border: `1px solid ${LAYER_COLOR[tooltip.node.layer]}44`,
          borderRadius: 8,
          padding: '12px 14px',
          boxShadow: `0 0 20px ${LAYER_COLOR[tooltip.node.layer]}22`,
          backdropFilter: 'blur(8px)',
          pointerEvents: 'none',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <div style={{
              width: 8, height: 8, borderRadius: '50%',
              background: LAYER_COLOR[tooltip.node.layer],
              boxShadow: `0 0 8px ${LAYER_COLOR[tooltip.node.layer]}`,
              flexShrink: 0,
            }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: '#e5e7eb' }}>
              {tooltip.node.label.replace('\n', ' ')}
            </span>
            <span style={{
              fontSize: 10, color: LAYER_COLOR[tooltip.node.layer],
              background: `${LAYER_COLOR[tooltip.node.layer]}1a`,
              padding: '1px 6px', borderRadius: 4,
            }}>
              {LAYER_LABEL[tooltip.node.layer]}
            </span>
          </div>
          <p style={{ fontSize: 11, color: '#9ca3af', margin: '0 0 10px 0', lineHeight: 1.5 }}>
            {tooltip.node.desc}
          </p>
          <div style={{ fontSize: 11, marginBottom: 6 }}>
            <div style={{ color: '#6b7280', marginBottom: 3 }}>▶ 输入</div>
            {tooltip.node.inputs.map((inp, i) => (
              <div key={i} style={{ color: '#d1d5db', paddingLeft: 10, marginBottom: 2, lineHeight: 1.4 }}>
                · {inp}
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11 }}>
            <div style={{ color: '#6b7280', marginBottom: 3 }}>◀ 输出</div>
            {tooltip.node.outputs.map((out, i) => (
              <div key={i} style={{ color: '#d1d5db', paddingLeft: 10, marginBottom: 2, lineHeight: 1.4 }}>
                · {out}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function nodeRadius(d: ArchNode): number {
  const base: Record<NodeLayer, number> = {
    channel: 32,
    outer:   42,
    inner:   42,
    storage: 38,
    llm:     36,
    tool:    26,
  };
  return base[d.layer] * (d.weight ?? 1) ** 0.35;
}

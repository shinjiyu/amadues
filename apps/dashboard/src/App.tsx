import { useCallback, useEffect, useMemo, useState } from 'react';
import { InnerLiveDeck, type BrainInspector, type PiLogsResponse } from './inner-live.js';
import { OuterPanel } from './outer-panel.js';
import { ParticipationLabPanel } from './participation-lab.js';
import { MemoryBlocksPanel } from './memory-blocks-panel.js';
import { LogExplorerPanel } from './log-explorer.js';
import { UsagePanel } from './usage-panel.js';
import { StallAlertsPanel } from './stall-alerts-panel.js';
import { WorkflowsPanel } from './workflows-panel.js';

/** 主 Tab = 当前运维关键面；高级 Tab = 旧设计/调试面 */
type Tab =
  | 'inner'
  | 'workflows'
  | 'usage'
  | 'stalls'
  | 'logs'
  | 'memory'
  | 'data'
  | 'outer'
  | 'participation';

const PRIMARY_TABS: Array<{ id: Tab; label: string }> = [
  { id: 'inner', label: '内脑 Burst' },
  { id: 'workflows', label: 'Workflows' },
  { id: 'usage', label: '用量' },
  { id: 'stalls', label: '空转' },
  { id: 'logs', label: '日志' },
  { id: 'memory', label: '记忆块' },
];

const ADVANCED_TABS: Array<{ id: Tab; label: string }> = [
  { id: 'data', label: '数据层（文件）' },
  { id: 'outer', label: '外脑快照' },
  { id: 'participation', label: '参与 Lab' },
];

const TENANT = 'default';

/** 已知 Agent 配置（与 vite.config.ts 代理路由对应，label 用 UTLRA_AGENT_NAME 显示名） */
const AGENTS = [
  { label: 'Kuroneko（8787）', apiPrefix: '/api' },
  { label: 'Shiro（8788）', apiPrefix: '/api2' },
  { label: 'Gin（8789）', apiPrefix: '/api3' },
  { label: 'Aoi（8791）', apiPrefix: '/api4' },
  { label: '元宝 / Lab（8793）', apiPrefix: '/api5' },
  { label: 'Bot1 / Coding（8796）', apiPrefix: '/api6' },
  { label: 'Bot2 / FP8（8797）', apiPrefix: '/api7' },
  { label: 'Bot3 / Legacy（8798）', apiPrefix: '/api8' },
] as const;
type AgentConfig = typeof AGENTS[number];

function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return '—';
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

type RepoRecordRow = {
  id: string;
  realm: string;
  lane: string;
  kind: string;
  title: string;
  committed_at: string;
};

type WorkspaceArtifacts = {
  workspaceId: string;
  workDir: string;
  revealAllowed: boolean;
  workspaceRootMarkdown: Array<{ path: string; size: number; modifiedAt: string }>;
  piMonoTree: Array<{ path: string; type: string; size?: number }>;
  toolOutputsTxtCount: number;
  toolOutputSample: Array<{ path: string; size: number; modifiedAt: string }>;
  deliverablesJsonPresent: boolean;
  deliverablesPreview: unknown;
  piMonoLogSpan: {
    file: string;
    firstTs: string | null;
    lastTs: string | null;
    lines: number;
  } | null;
  piMonoLogDurationMs: number | null;
};

const BRAIN_CORE_FILES = [
  '.brain/goal.md',
  '.brain/memory.json',
  '.brain/dyflow-state.json',
  '.brain/local_dag.json',
  '.brain/local_nodes/index.json',
] as const;

const BRAIN_CORE_LABEL: Record<string, string> = {
  '.brain/goal.md': '目标 goal.md',
  '.brain/memory.json': '全局 memory',
  '.brain/dyflow-state.json': 'DyFlow 状态',
  '.brain/local_dag.json': '当前 DAG',
  '.brain/local_nodes/index.json': 'LocalNode 索引',
};

function coreBrainSortKey(p: string): number {
  const i = BRAIN_CORE_FILES.indexOf(p as (typeof BRAIN_CORE_FILES)[number]);
  if (i >= 0) return i;
  if (p.startsWith('.brain/skills/') && p.endsWith('.md')) return 50 + p.length;
  return 999;
}

export function App() {
  const [tab, setTab] = useState<Tab>('inner');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [agentIdx, setAgentIdx] = useState(0);
  const [ws, setWs] = useState('default');
  const [wsList, setWsList] = useState<string[]>(['default']);

  const agent: AgentConfig = AGENTS[agentIdx]!;
  const apiPrefix = agent.apiPrefix;
  const needsWorkspace = tab === 'data' || tab === 'outer';

  // 切换 agent 时重新拉 workspace 列表
  useEffect(() => {
    void fetch(`${apiPrefix}/workspaces`)
      .then((r) => r.json())
      .then((j: unknown) => {
        const ids = (j as { workspaces?: string[] }).workspaces ?? [];
        const list = ids.length > 0 ? ids : ['default'];
        setWsList(list);
        setWs((prev) => (list.includes(prev) ? prev : list[0]!));
      })
      .catch(() => {
        setWsList(['default']);
        setWs('default');
      });
  }, [agentIdx, apiPrefix]);

  useEffect(() => {
    if (ADVANCED_TABS.some((t) => t.id === tab)) setShowAdvanced(true);
  }, [tab]);

  return (
    <div>
      <header
        style={{
          padding: '1rem',
          borderBottom: '1px solid #2a3142',
          background: '#12151c',
        }}
      >
        <h1 style={{ margin: 0, fontSize: '1.25rem' }}>Kuroneko 控制台</h1>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: '#8b92a8' }}>Agent：</span>
          {AGENTS.map((a, i) => (
            <button
              key={a.apiPrefix}
              type="button"
              style={{
                fontSize: 12,
                padding: '2px 10px',
                background: agentIdx === i ? '#3b4a6b' : '#1d2333',
                border: agentIdx === i ? '1px solid #5b7ac5' : '1px solid #2a3142',
                borderRadius: 4,
                color: agentIdx === i ? '#c8d8ff' : '#8b92a8',
                cursor: 'pointer',
              }}
              onClick={() => setAgentIdx(i)}
            >
              {a.label}
            </button>
          ))}
          {needsWorkspace && (
            <>
              <span style={{ fontSize: 13, color: '#8b92a8', marginLeft: 8 }}>Workspace：</span>
              <select
                value={ws}
                onChange={(e) => setWs(e.target.value)}
                style={{ fontSize: 12, background: '#1d2333', color: '#c8d8ff', border: '1px solid #2a3142', borderRadius: 4, padding: '2px 6px' }}
              >
                {wsList.map((id) => (
                  <option key={id} value={id}>{id}</option>
                ))}
              </select>
            </>
          )}
        </div>
        <p style={{ margin: '0.35rem 0 0', fontSize: 12, color: '#5a6180' }}>
          Burst / EW / 用量 / 空转 · 只读监控
        </p>
      </header>
      <div className="panel">
        <div className="tabs">
          {PRIMARY_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={tab === t.id ? 'active' : ''}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
          <button
            type="button"
            className={showAdvanced || ADVANCED_TABS.some((t) => t.id === tab) ? 'active' : ''}
            onClick={() => setShowAdvanced((v) => !v)}
            title="旧设计面：文件树 / 外脑快照 / 参与 Lab"
          >
            高级{showAdvanced ? ' ▾' : ' ▸'}
          </button>
          {showAdvanced &&
            ADVANCED_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={tab === t.id ? 'active' : ''}
                onClick={() => setTab(t.id)}
                style={{ opacity: 0.85, fontSize: 12 }}
              >
                {t.label}
              </button>
            ))}
        </div>
        {tab === 'inner' && <InnerBrainPoolPanel apiPrefix={apiPrefix} />}
        {tab === 'workflows' && <WorkflowsPanel apiPrefix={apiPrefix} />}
        {tab === 'usage' && <UsagePanel apiPrefix={apiPrefix} />}
        {tab === 'stalls' && <StallAlertsPanel apiPrefix={apiPrefix} />}
        {tab === 'logs' && <LogExplorerPanel apiPrefix={apiPrefix} />}
        {tab === 'memory' && <MemoryPanel apiPrefix={apiPrefix} />}
        {tab === 'data' && <DataPanel workspaceId={ws} apiPrefix={apiPrefix} />}
        {tab === 'outer' && <OuterPanel workspaceId={ws} apiPrefix={apiPrefix} />}
        {tab === 'participation' && <ParticipationLabPanel apiPrefix={apiPrefix} />}
      </div>
    </div>
  );
}

// ── Memory Panel ─────────────────────────────────────────────────────────────

function MemoryPanel({ apiPrefix }: { apiPrefix: string }) {
  return (
    <div style={{ padding: '0.5rem 0' }}>
      <p style={{ margin: '0 0 12px', fontSize: 12, color: '#8b92a8' }}>
        当前关键：Memory Blocks（keychain / facts 等）。旧 daily-log / tasks.md 编辑器已移除。
      </p>
      <MemoryBlocksPanel apiPrefix={apiPrefix} />
    </div>
  );
}

function DataPanel({ workspaceId, apiPrefix }: { workspaceId: string; apiPrefix: string }) {
  const [manifest, setManifest] = useState<unknown>(null);
  const [tree, setTree] = useState<{ path: string; type: string; size?: number }[]>([]);
  const [brainTree, setBrainTree] = useState<{ path: string; type: string; size?: number }[]>([]);
  const [artifacts, setArtifacts] = useState<WorkspaceArtifacts | null>(null);
  const [filePath, setFilePath] = useState('.run/manifest.json');
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [health, setHealth] = useState<unknown>(null);
  const [err, setErr] = useState<string | null>(null);
  const [revealMsg, setRevealMsg] = useState<string | null>(null);
  const [repoRecords, setRepoRecords] = useState<RepoRecordRow[]>([]);

  const refresh = useCallback(async () => {
    setErr(null);
    setRevealMsg(null);
    try {
      await fetch(`${apiPrefix}/workspaces/${workspaceId}/init`, { method: 'POST' });
      const [h, m, t, b, art, repo] = await Promise.all([
        fetch(`${apiPrefix}/health`).then((r) => r.json()),
        fetch(`${apiPrefix}/workspaces/${workspaceId}/manifest`).then((r) => r.json()),
        fetch(`${apiPrefix}/workspaces/${workspaceId}/tree?path=.run`).then((r) => r.json()),
        fetch(`${apiPrefix}/workspaces/${workspaceId}/tree?path=.brain`).then((r) => r.json()),
        fetch(`${apiPrefix}/workspaces/${workspaceId}/artifacts`).then((r) => r.json()),
        fetch(`${apiPrefix}/repository/${TENANT}/records?limit=400`).then((r) => r.json()),
      ]);
      setHealth(h);
      setManifest(m);
      setTree(t.entries ?? []);
      setBrainTree(b.entries ?? []);
      setArtifacts(art as WorkspaceArtifacts);
      setRepoRecords((repo.records as RepoRecordRow[]) ?? []);
    } catch (e) {
      setErr(String(e));
    }
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadFileAt = useCallback(
    async (rel: string) => {
      setErr(null);
      setFilePath(rel);
      const r = await fetch(`${apiPrefix}/workspaces/${workspaceId}/file?path=${encodeURIComponent(rel)}`);
      if (!r.ok) {
        setFileContent(null);
        setErr(await r.text());
        return;
      }
      const j = await r.json();
      setFileContent(j.content as string);
    },
    [workspaceId],
  );

  const loadFile = async () => {
    await loadFileAt(filePath);
  };

  const copyWorkDir = async () => {
    if (!artifacts?.workDir) return;
    try {
      await navigator.clipboard.writeText(artifacts.workDir);
      setRevealMsg('已复制路径到剪贴板');
    } catch {
      setRevealMsg('复制失败（浏览器权限）');
    }
  };

  const revealWorkDir = async () => {
    setRevealMsg(null);
    const r = await fetch(`${apiPrefix}/workspaces/${workspaceId}/reveal`, { method: 'POST' });
    const j = (await r.json()) as { ok?: boolean; error?: string };
    if (!r.ok || !j.ok) {
      setRevealMsg(j.error ?? `HTTP ${r.status}`);
      return;
    }
    setRevealMsg('已在文件管理器中打开');
  };

  const span = artifacts?.piMonoLogSpan;

  const coreBrainFiles = useMemo(() => {
    const coreSet = new Set<string>([...BRAIN_CORE_FILES]);
    return brainTree
      .filter(
        (e) =>
          e.type === 'file' &&
          (coreSet.has(e.path) || (e.path.startsWith('.brain/skills/') && e.path.endsWith('.md'))),
      )
      .sort((a, b) => coreBrainSortKey(a.path) - coreBrainSortKey(b.path));
  }, [brainTree]);

  return (
    <div>
      {err && <div className="card" style={{ color: '#f0a8a8' }}>{err}</div>}
      {revealMsg && (
        <div className="card" style={{ fontSize: 13, color: '#9fe8c3' }}>
          {revealMsg}
        </div>
      )}

      <div className="card viz-core-hero">
        <div className="viz-core-hero-head">
          <h2 className="viz-core-title">核心产出</h2>
          <p className="viz-core-sub">
            交付报告（workspace 根目录）与 DyFlow 脑内状态文件（memory / DAG / LocalNode）。下方可预览全文。
          </p>
        </div>

        <div className="viz-core-toolbar">
          <button type="button" className="viz-refresh" onClick={() => void refresh()}>
            刷新数据
          </button>
          {artifacts && (
            <>
              <button type="button" onClick={() => void copyWorkDir()}>
                复制工作目录路径
              </button>
              {artifacts.revealAllowed ? (
                <button type="button" onClick={() => void revealWorkDir()}>
                  在访达 / 资源管理器中打开
                </button>
              ) : null}
            </>
          )}
        </div>
        {artifacts && (
          <>
            <code className="viz-workdir">{artifacts.workDir}</code>
            {!artifacts.revealAllowed && (
              <p className="viz-note">已关闭「在访达中打开」（UTLRA_DISABLE_WORKSPACE_REVEAL）</p>
            )}
          </>
        )}

        <h3 className="viz-core-h3">交付物 · 根目录报告</h3>
        {artifacts && artifacts.workspaceRootMarkdown.length > 0 ? (
          <div className="viz-chip-grid">
            {artifacts.workspaceRootMarkdown.map((row) => (
              <button
                key={row.path}
                type="button"
                className="viz-chip viz-chip-report"
                onClick={() => void loadFileAt(row.path)}
              >
                <span className="viz-chip-name">{row.path}</span>
                <span className="viz-chip-meta">
                  {(row.size / 1024).toFixed(1)} KB · {row.modifiedAt.slice(0, 10)}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="viz-empty">尚无根目录 *.md 报告（任务完成后会出现）</p>
        )}

        <h3 className="viz-core-h3">Agent 脑内 · DyFlow 状态</h3>
        {coreBrainFiles.length > 0 ? (
          <div className="viz-chip-grid">
            {coreBrainFiles.map((e) => (
              <button
                key={e.path}
                type="button"
                className="viz-chip viz-chip-brain"
                onClick={() => void loadFileAt(e.path)}
              >
                <span className="viz-chip-name">
                  {BRAIN_CORE_LABEL[e.path] ??
                    `技能 ${e.path.replace(/^\.brain\/skills\//, '')}`}
                </span>
                <span className="viz-chip-meta">{e.path}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="viz-empty">尚无 .brain 核心文件（先跑 Pi-mono）</p>
        )}

        <h3 className="viz-core-h3">[调试] 执行轨知识库（Repository）</h3>
        <p className="viz-note" style={{ marginBottom: 10 }}>
          仅用于本地排查索引是否写入；正式闭环由外脑编排完成（<code>POST /api/outer/inbound</code> 或 IM 渠道，以及{' '}
          <code>POST /api/outer/workspace/…/shutdown</code>）。数据目录 <code>data/repository/{TENANT}/</code>。检索：{' '}
          <code>POST /api/repository/{TENANT}/retrieve</code>。
        </p>
        {repoRecords.length > 0 ? (
          <div className="viz-advanced-scroll">
            <table className="viz-advanced-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>lane</th>
                  <th>kind</th>
                  <th>realm</th>
                  <th>标题</th>
                </tr>
              </thead>
              <tbody>
                {repoRecords.map((r) => (
                  <tr key={r.id}>
                    <td>{r.committed_at.slice(0, 19)}</td>
                    <td>{r.lane}</td>
                    <td>{r.kind}</td>
                    <td>
                      <code>{r.realm}</code>
                    </td>
                    <td style={{ maxWidth: 360, wordBreak: 'break-word' }}>{r.title}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="viz-empty">
            尚无晋升记录（生产路径应走外脑 inbound / shutdown；内脑页的「晋升并关闭」为调试/手动）
          </p>
        )}
      </div>

      <div className="card viz-preview-card">
        <strong className="viz-preview-label">内容预览</strong>
        <div className="row" style={{ marginTop: 10, flexWrap: 'wrap', gap: 8 }}>
          <input
            className="viz-path-input"
            value={filePath}
            onChange={(ev) => setFilePath(ev.target.value)}
            placeholder="相对 workspace 路径"
          />
          <button type="button" onClick={() => void loadFile()}>
            读取
          </button>
        </div>
        {fileContent !== null && (
          <pre className="viz-preview-body">{fileContent}</pre>
        )}
      </div>

      <details className="viz-advanced">
        <summary>次要信息（日志跨度、manifest、目录树、工具缓存…）</summary>

        {artifacts && span && (
          <p className="viz-advanced-p">
            Pi-mono 日志 <code>{span.file}</code>：{span.lines} 行 ·{' '}
            {span.firstTs ?? '—'} → {span.lastTs ?? '—'} · 跨度约{' '}
            <strong>{formatDurationMs(artifacts.piMonoLogDurationMs)}</strong>
          </p>
        )}

        <p className="viz-advanced-p muted">
          <code>manifest.outcomes.*</code> 不会自动收录 <code>.brain/</code>，多为空属预期；Mem0 非本页范围。
        </p>

        {artifacts?.deliverablesJsonPresent && (
          <div className="viz-advanced-block">
            <strong>deliverables.json</strong>
            <pre className="viz-advanced-pre">{JSON.stringify(artifacts.deliverablesPreview, null, 2)}</pre>
          </div>
        )}

        {artifacts && artifacts.piMonoTree.length > 0 && (
          <div className="viz-advanced-block">
            <strong>.run/pi-mono</strong>
            <div className="viz-advanced-scroll">
              <table className="viz-advanced-table">
                <tbody>
                  {artifacts.piMonoTree.map((e) => (
                    <tr key={e.path}>
                      <td>
                        <code>{e.path}</code>
                      </td>
                      <td>{e.type}</td>
                      <td>{e.size ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {artifacts && artifacts.toolOutputsTxtCount > 0 && (
          <div className="viz-advanced-block">
            <strong>.tool-outputs（{artifacts.toolOutputsTxtCount} 个，抽样）</strong>
            <ul className="viz-advanced-list">
              {artifacts.toolOutputSample.map((row) => (
                <li key={row.path}>
                  <button type="button" className="viz-link-btn" onClick={() => void loadFileAt(row.path)}>
                    {row.path}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="viz-advanced-block">
          <strong>API health</strong>
          <pre className="viz-advanced-pre">{JSON.stringify(health, null, 2)}</pre>
        </div>
        <div className="viz-advanced-block">
          <strong>manifest.json</strong>
          <pre className="viz-advanced-pre">{JSON.stringify(manifest, null, 2)}</pre>
        </div>
        <div className="viz-advanced-block">
          <strong>.run 目录树</strong>
          <div className="viz-advanced-scroll">
            <table className="viz-advanced-table">
              <tbody>
                {tree.length === 0 ? (
                  <tr>
                    <td className="muted">无条目</td>
                  </tr>
                ) : (
                  tree.map((e) => (
                    <tr key={e.path}>
                      <td>
                        <code>{e.path}</code>
                      </td>
                      <td>{e.type}</td>
                      <td>{e.size ?? '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div className="viz-advanced-block">
          <strong>.brain 完整目录树</strong>
          <div className="viz-advanced-scroll">
            <table className="viz-advanced-table">
              <tbody>
                {brainTree.length === 0 ? (
                  <tr>
                    <td className="muted">尚无 .brain</td>
                  </tr>
                ) : (
                  brainTree.map((e) => (
                    <tr key={e.path}>
                      <td>
                        <code>{e.path}</code>
                      </td>
                      <td>{e.type}</td>
                      <td>{e.size ?? '—'}</td>
                      <td>
                        {e.type === 'file' ? (
                          <button type="button" className="viz-link-btn" onClick={() => void loadFileAt(e.path)}>
                            预览
                          </button>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </details>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// InnerBrainPoolPanel — 多内脑池视图
// ─────────────────────────────────────────────────────────────────────────────

type InstanceRow = {
  instance_id: string;
  workspace_id: string;
  registry_status: 'RUNNING' | 'BLOCKED' | 'DONE' | 'STOPPED' | 'ERROR' | 'AWAITING' | 'ABORTED';
  kpi_id?: string | null;
  liveness: 'active' | 'stuck' | 'dead' | null;
  pid: number | null;
  pid_alive: boolean | null;
  worker_phase: string | null;
  last_tick_at: string | null;
  phase: string | null;
  goal: string;
  origin_user: string;
  started_at: string;
  finished_at: string | null;
  ticks: number | null;
  error: string | null;
  engine?: 'dyflow' | 'legacy' | 'execute' | null;
  dyflow_mode?: string | null;
  dyflow_dag_nodes?: number | null;
  dyflow_failure?: string | null;
  dyflow_progress?: string | null;
};

const STATUS_COLOR: Record<string, string> = {
  RUNNING: '#4ade80',
  DONE:    '#60a5fa',
  BLOCKED: '#facc15',
  STOPPED: '#94a3b8',
  ERROR:   '#f87171',
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60)  return `${sec}s 前`;
  const min = Math.floor(sec / 60);
  if (min < 60)  return `${min}m 前`;
  const hr = Math.floor(min / 60);
  if (hr < 24)   return `${hr}h 前`;
  return `${Math.floor(hr / 24)}d 前`;
}

const INNER_BRAIN_PAGE_SIZE = 20;
const INNER_BRAIN_POLL_MS = 8000;

function InnerBrainPoolPanel({ apiPrefix }: { apiPrefix: string }) {
  const [instances, setInstances] = useState<InstanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null); // workspaceId
  const [stopping, setStopping] = useState<string | null>(null);
  const [restarting, setRestarting] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [statusFilter, setStatusFilter] = useState<'live' | 'all'>('all');
  const [registryTotal, setRegistryTotal] = useState(0);

  const refresh = useCallback(async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 12_000);
    try {
      const qs = new URLSearchParams({
        page: String(page),
        pageSize: String(INNER_BRAIN_PAGE_SIZE),
        status: statusFilter,
      });
      const r = await fetch(`${apiPrefix}/inner-brains?${qs}`, { signal: ac.signal });
      if (!r.ok) {
        const hint = r.status === 502 || r.status === 503
          ? '（Agent 可能未启动：对应端口无进程）'
          : '';
        throw new Error(`HTTP ${r.status} ${r.statusText}${hint}`);
      }
      const text = await r.text();
      if (!text.trim()) {
        throw new Error('空响应（Agent 未启动或 Vite 代理失败）');
      }
      const j = JSON.parse(text) as {
        instances?: InstanceRow[];
        total?: number;
        page?: number;
        totalPages?: number;
        registryTotal?: number;
      };
      const rows = j.instances ?? [];
      const tp = Math.max(1, j.totalPages ?? 1);
      const t = j.total ?? rows.length;

      if (rows.length === 0 && t > 0 && page > tp) {
        setPage(tp);
        return;
      }

      setInstances(rows);
      setTotal(t);
      setTotalPages(tp);
      setRegistryTotal(j.registryTotal ?? t);
      if (typeof j.page === 'number' && j.page !== page) {
        setPage(j.page);
      }
      setErr(null);
    } catch (e) {
      const msg =
        e instanceof DOMException && e.name === 'AbortError'
          ? '请求超时（12s）：Agent 可能卡住或未启动'
          : String(e);
      setErr(msg);
    } finally {
      clearTimeout(timer);
      setLoading(false);
    }
  }, [apiPrefix, page, statusFilter]);
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), INNER_BRAIN_POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const stopInstance = async (instanceId: string) => {
    setStopping(instanceId);
    try {
      await fetch(`${apiPrefix}/inner-brains/${instanceId}/stop`, { method: 'POST' });
      await refresh();
    } finally {
      setStopping(null);
    }
  };

  const restartInstance = async (instanceId: string) => {
    setRestarting(instanceId);
    try {
      await fetch(`${apiPrefix}/inner-brains/${instanceId}/restart`, { method: 'POST' });
      await refresh();
    } finally {
      setRestarting(null);
    }
  };

  if (selected) {
    return (
      <div>
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0.6rem 1rem' }}>
          <button type="button" onClick={() => setSelected(null)} style={{ fontSize: 12 }}>
            ← 返回 Burst 列表
          </button>
          <span style={{ fontSize: 13, color: '#8b92a8' }}>workspace：<code>{selected}</code></span>
        </div>
        <InnerPanel workspaceId={selected} apiPrefix={apiPrefix} />
      </div>
    );
  }

  return (
    <div>
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 15 }}>内脑 Burst</strong>
          <span style={{ fontSize: 12, color: '#8b92a8' }}>
            {loading
              ? '加载中…'
              : statusFilter === 'live'
                ? `进行中 ${total} · 注册表 ${registryTotal}`
                : `共 ${total} · 第 ${page}/${totalPages} 页`}
          </span>
          <label style={{ fontSize: 12, color: '#8b92a8', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            范围
            <select
              value={statusFilter}
              onChange={(e) => {
                setPage(1);
                setStatusFilter(e.target.value as 'live' | 'all');
              }}
              style={{ fontSize: 12 }}
            >
              <option value="all">最近历史</option>
              <option value="live">仅进行中</option>
            </select>
          </label>
          <button type="button" style={{ marginLeft: 'auto', fontSize: 12 }} onClick={() => void refresh()}>
            刷新
          </button>
        </div>
        {err && <p style={{ color: '#f87171', fontSize: 13 }}>{err}</p>}
        {!loading && instances.length === 0 && (
          <p style={{ color: '#8b92a8', fontSize: 13 }}>
            {statusFilter === 'live'
              ? `当前无进行中的 burst（注册表共 ${registryTotal}）。可切「最近历史」。`
              : '暂无 burst。外脑 set_goal / workflow_run 后会出现。'}
          </p>
        )}
        {instances.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table className="viz-advanced-table" style={{ width: '100%', fontSize: 13 }}>
              <thead>
                <tr>
                  <th>状态 / 引擎</th>
                  <th>KPI</th>
                  <th>目标</th>
                  <th>时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {instances.map((inst) => {
                  const color = STATUS_COLOR[inst.registry_status] ?? '#8b92a8';
                  const dur = inst.finished_at
                    ? Math.round((new Date(inst.finished_at).getTime() - new Date(inst.started_at).getTime()) / 1000) + 's'
                    : inst.registry_status === 'RUNNING' ? '…' : '—';
                  const engineLine =
                    inst.engine === 'execute'
                      ? `EW · ${inst.dyflow_progress ?? inst.dyflow_mode ?? 'execute'}`
                      : inst.engine === 'dyflow'
                        ? `DyFlow · ${inst.dyflow_mode ?? '?'}${inst.dyflow_progress ? ` · ${inst.dyflow_progress}` : ''}`
                        : null;
                  return (
                    <tr key={inst.instance_id}>
                      <td style={{ minWidth: 140 }}>
                        <span style={{ color, fontWeight: 600, fontSize: 12 }}>
                          {inst.registry_status}
                        </span>
                        {inst.liveness === 'dead' && (
                          <span style={{ color: '#f87171', fontSize: 11, display: 'block', fontWeight: 600 }}>✕ 进程已死</span>
                        )}
                        {inst.liveness === 'stuck' && (
                          <span style={{ color: '#fb923c', fontSize: 11, display: 'block', fontWeight: 600 }}>⚠ 卡住</span>
                        )}
                        {engineLine && (
                          <span
                            style={{
                              color: inst.engine === 'execute' ? '#38bdf8' : '#a78bfa',
                              fontSize: 11,
                              display: 'block',
                              fontWeight: 600,
                            }}
                          >
                            {engineLine}
                          </span>
                        )}
                        {inst.dyflow_failure && (
                          <span style={{ color: '#fb923c', fontSize: 10, display: 'block' }} title={inst.dyflow_failure}>
                            ⚠ {inst.dyflow_failure}
                          </span>
                        )}
                        <code style={{ fontSize: 10, color: '#5a6180' }}>{inst.instance_id}</code>
                      </td>
                      <td style={{ fontSize: 11, color: '#8b92a8', maxWidth: 140, wordBreak: 'break-all' }}>
                        {inst.kpi_id ? <code>{inst.kpi_id}</code> : '—'}
                      </td>
                      <td style={{ maxWidth: 360, wordBreak: 'break-word' }}>
                        {inst.goal.slice(0, 140)}{inst.goal.length > 140 ? '…' : ''}
                        {inst.error && (
                          <span style={{ color: '#f87171', display: 'block', fontSize: 11 }}>
                            {inst.error.slice(0, 80)}
                          </span>
                        )}
                      </td>
                      <td style={{ fontSize: 11, color: '#8b92a8', whiteSpace: 'nowrap' }}>
                        {timeAgo(inst.started_at)}
                        <span style={{ display: 'block' }}>{dur}</span>
                        {inst.last_tick_at && inst.registry_status === 'RUNNING' && (
                          <span style={{ display: 'block', color: inst.liveness === 'stuck' ? '#fb923c' : undefined }}>
                            tick {timeAgo(inst.last_tick_at)}
                          </span>
                        )}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button
                          type="button"
                          style={{ fontSize: 11, marginRight: 6 }}
                          onClick={() => setSelected(inst.workspace_id)}
                        >
                          执行图
                        </button>
                        {inst.registry_status === 'RUNNING' && (
                          <button
                            type="button"
                            className="danger"
                            style={{ fontSize: 11 }}
                            disabled={stopping === inst.instance_id}
                            onClick={() => void stopInstance(inst.instance_id)}
                          >
                            {stopping === inst.instance_id ? '停止中…' : '停止'}
                          </button>
                        )}
                        {(inst.registry_status === 'STOPPED' ||
                          inst.registry_status === 'ERROR' ||
                          (inst.registry_status === 'RUNNING' && inst.liveness === 'dead')) && (
                          <button
                            type="button"
                            style={{ fontSize: 11, background: '#1e3a5f', borderColor: '#3b6ea5' }}
                            disabled={restarting === inst.instance_id}
                            title="从磁盘续跑"
                            onClick={() => void restartInstance(inst.instance_id)}
                          >
                            {restarting === inst.instance_id ? '续跑中…' : '续跑'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {!loading && totalPages > 1 && (
          <div
            className="inner-brain-pagination"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 10,
              marginTop: 12,
              fontSize: 12,
              color: '#8b92a8',
            }}
          >
            <button
              type="button"
              style={{ fontSize: 12 }}
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              上一页
            </button>
            <span>
              第 {page} / {totalPages} 页（每页 {INNER_BRAIN_PAGE_SIZE} 条）
            </span>
            <button
              type="button"
              style={{ fontSize: 12 }}
              disabled={page >= totalPages || loading}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              下一页
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// InnerPanel — 单内脑工作区详情（供 InnerBrainPoolPanel 钻取使用）
// ─────────────────────────────────────────────────────────────────────────────

function InnerPanel({ workspaceId, apiPrefix }: { workspaceId: string; apiPrefix: string }) {
  const [brainInsp, setBrainInsp] = useState<BrainInspector | null>(null);
  const [piLogs, setPiLogs] = useState<PiLogsResponse | null>(null);
  const [insightLoaded, setInsightLoaded] = useState(false);
  const [insightErr, setInsightErr] = useState<string | null>(null);

  const pullInsight = useCallback(async () => {
    try {
      setInsightErr(null);
      const [rb, rl] = await Promise.all([
        fetch(`${apiPrefix}/inner/${workspaceId}/brain-inspector`),
        fetch(`${apiPrefix}/inner/${workspaceId}/pi-logs?limit=80`),
      ]);
      if (!rb.ok) throw new Error(`brain-inspector HTTP ${rb.status}`);
      if (!rl.ok) throw new Error(`pi-logs HTTP ${rl.status}`);
      const [b, l] = await Promise.all([rb.json(), rl.json()]);
      setBrainInsp(b as BrainInspector);
      setPiLogs(l as PiLogsResponse);
    } catch (e) {
      setInsightErr(e instanceof Error ? e.message : String(e));
    } finally {
      setInsightLoaded(true);
    }
  }, [apiPrefix, workspaceId]);

  useEffect(() => {
    const id = setInterval(() => void pullInsight(), 2500);
    void pullInsight();
    return () => clearInterval(id);
  }, [pullInsight]);

  return (
    <div>
      {insightErr && (
        <div className="card" style={{ color: '#f0a8a8', borderColor: '#6b3030' }}>
          执行图接口失败：{insightErr}
        </div>
      )}
      <InnerLiveDeck
        brain={brainInsp}
        logs={piLogs}
        piBusy={false}
        insightLoading={!insightLoaded}
      />
      <div className="card" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" style={{ fontSize: 12 }} onClick={() => void pullInsight()}>
          刷新执行图
        </button>
        <span style={{ fontSize: 12, color: '#8b92a8' }}>
          主视图 = DyFlow DAG / EW steps。Pi-mono 单步 / Auto / reset 已移出运维面。
        </span>
      </div>
    </div>
  );
}

// ModelBenchPanel — 模型 API 测速界面
// ─────────────────────────────────────────────────────────────────────────────

type ProbeResult = {
  model: string;
  ms: number;
  ok: boolean;
  httpStatus?: number;
  finishReason?: string;
  content?: string;
  hasThinking?: boolean;
  promptTokens?: number;
  completionTokens?: number;
  error?: string;
  errorCode?: string;
  state: 'idle' | 'running' | 'done';
};

const PRESET_MODELS = [
  'glm-5',
  'glm-5.1',
  'glm-4-flash',
  'glm-4-flashx',
  'glm-4-air',
  'glm-4-airx',
  'glm-4-plus',
  'glm-4-long',
  'glm-z1-flash',
  'glm-z1-air',
  'glm-z1-airx',
  'glm-5v-turbo',
];

function latencyBar(ms: number, maxMs = 30000): React.ReactNode {
  const pct = Math.min(100, (ms / maxMs) * 100);
  const color = ms < 1000 ? '#4ade80' : ms < 5000 ? '#facc15' : ms < 15000 ? '#fb923c' : '#f87171';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ width: 80, height: 8, background: '#1d2333', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 4, transition: 'width 0.3s' }} />
      </div>
      <span style={{ color, fontSize: 12, fontVariantNumeric: 'tabular-nums', minWidth: 54 }}>
        {ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}
      </span>
    </div>
  );
}

function ModelBenchPanel({ apiPrefix }: { apiPrefix: string }) {
  const [results, setResults] = useState<Map<string, ProbeResult>>(
    () => new Map(PRESET_MODELS.map((m) => [m, { model: m, ms: 0, ok: false, state: 'idle' }])),
  );
  const [prompt, setPrompt] = useState('用一句话介绍你自己');
  const [maxTokens, setMaxTokens] = useState('2048');
  const [running, setRunning] = useState(false);
  const [customModel, setCustomModel] = useState('');

  const probeOne = useCallback(
    async (model: string) => {
      setResults((prev) => {
        const next = new Map(prev);
        next.set(model, { model, ms: 0, ok: false, state: 'running' });
        return next;
      });
      const startAt = Date.now();
      try {
        const res = await fetch(`${apiPrefix}/models/probe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, prompt, maxTokens: Number(maxTokens) || 2048 }),
        });
        const data = (await res.json()) as ProbeResult;
        setResults((prev) => {
          const next = new Map(prev);
          next.set(model, { ...data, ms: data.ms ?? Date.now() - startAt, state: 'done' });
          return next;
        });
      } catch (e) {
        setResults((prev) => {
          const next = new Map(prev);
          next.set(model, { model, ms: Date.now() - startAt, ok: false, error: String(e), state: 'done' });
          return next;
        });
      }
    },
    [apiPrefix, prompt, maxTokens],
  );

  const runAll = useCallback(async () => {
    setRunning(true);
    const models = [...results.keys()];
    await Promise.all(models.map((m) => probeOne(m)));
    setRunning(false);
  }, [results, probeOne]);

  const addCustomModel = () => {
    const m = customModel.trim();
    if (!m || results.has(m)) return;
    setResults((prev) => {
      const next = new Map(prev);
      next.set(m, { model: m, ms: 0, ok: false, state: 'idle' });
      return next;
    });
    setCustomModel('');
  };

  const rows = [...results.values()];
  const doneRows = rows.filter((r) => r.state === 'done' && r.ok);
  const maxMs = doneRows.length > 0 ? Math.max(...doneRows.map((r) => r.ms)) : 30000;

  return (
    <div style={{ padding: '1rem' }}>
      {/* 配置区 */}
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 260px' }}>
            <label style={{ fontSize: 12, color: '#8b92a8', display: 'block', marginBottom: 4 }}>测试 Prompt</label>
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              style={{ width: '100%', boxSizing: 'border-box', fontSize: 13 }}
            />
          </div>
          <div style={{ flex: '0 0 120px' }}>
            <label style={{ fontSize: 12, color: '#8b92a8', display: 'block', marginBottom: 4 }}>max_tokens</label>
            <input
              type="number"
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value)}
              style={{ width: '100%', boxSizing: 'border-box', fontSize: 13 }}
            />
          </div>
          <button
            type="button"
            disabled={running}
            onClick={() => void runAll()}
            style={{
              padding: '6px 18px',
              fontSize: 13,
              background: running ? '#1d2333' : '#2a4a6b',
              border: '1px solid #3b6ea5',
              borderRadius: 4,
              color: running ? '#8b92a8' : '#c8d8ff',
              cursor: running ? 'not-allowed' : 'pointer',
            }}
          >
            {running ? '测试中…' : '全部测速'}
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
          <input
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addCustomModel(); }}
            placeholder="添加自定义模型名"
            style={{ fontSize: 12, width: 200 }}
          />
          <button type="button" onClick={addCustomModel} style={{ fontSize: 12, padding: '3px 10px' }}>
            添加
          </button>
        </div>
      </div>

      {/* 结果表格 */}
      <div className="card" style={{ overflowX: 'auto' }}>
        <table className="viz-advanced-table" style={{ width: '100%', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ width: 140 }}>模型</th>
              <th style={{ width: 40 }}>状态</th>
              <th style={{ width: 160 }}>延迟</th>
              <th style={{ width: 80 }}>tokens</th>
              <th style={{ width: 60 }}>思考</th>
              <th>回复预览</th>
              <th style={{ width: 70 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.model}>
                <td>
                  <code style={{ fontSize: 11 }}>{r.model}</code>
                </td>
                <td style={{ textAlign: 'center' }}>
                  {r.state === 'idle' && <span style={{ color: '#5a6180' }}>—</span>}
                  {r.state === 'running' && (
                    <span style={{ color: '#facc15', fontSize: 12 }}>⏳</span>
                  )}
                  {r.state === 'done' && r.ok && <span style={{ color: '#4ade80' }}>✅</span>}
                  {r.state === 'done' && !r.ok && (
                    <span title={r.error ?? ''} style={{ color: '#f87171' }}>
                      ❌{r.httpStatus ? ` ${r.httpStatus}` : ''}
                    </span>
                  )}
                </td>
                <td>
                  {r.state === 'running' && (
                    <span style={{ color: '#8b92a8', fontSize: 12 }}>请求中…</span>
                  )}
                  {r.state === 'done' && r.ms > 0 && latencyBar(r.ms, maxMs)}
                  {r.state === 'idle' && <span style={{ color: '#5a6180', fontSize: 12 }}>—</span>}
                </td>
                <td style={{ fontSize: 12, color: '#8b92a8', textAlign: 'center' }}>
                  {r.state === 'done' && r.ok ? (r.completionTokens ?? '?') : '—'}
                </td>
                <td style={{ textAlign: 'center', fontSize: 12 }}>
                  {r.state === 'done' && r.hasThinking ? (
                    <span title="该模型返回思考过程（reasoning_content 或 <think> 标签）" style={{ color: '#60a5fa' }}>🧠</span>
                  ) : r.state === 'done' ? '—' : ''}
                </td>
                <td style={{ maxWidth: 360, fontSize: 12, color: r.ok ? '#c8d8ff' : '#f87171', wordBreak: 'break-word' }}>
                  {r.state === 'done' && (r.content || r.error)}
                  {r.state === 'idle' && <span style={{ color: '#5a6180' }}>未测试</span>}
                  {r.state === 'running' && <span style={{ color: '#8b92a8' }}>…</span>}
                </td>
                <td>
                  <button
                    type="button"
                    disabled={r.state === 'running'}
                    onClick={() => void probeOne(r.model)}
                    style={{ fontSize: 11, padding: '2px 8px' }}
                  >
                    {r.state === 'running' ? '…' : '测速'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: 11, color: '#5a6180', marginTop: 8 }}>
        延迟条以本轮最慢模型为基准（100%）。🧠 表示模型含推理 token（thinking model）。
        当前配置：<code>{apiPrefix}/models/probe</code>
      </p>
    </div>
  );
}

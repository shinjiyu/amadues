import { useCallback, useEffect, useMemo, useState } from 'react';
import { InnerLiveDeck, type BrainInspector, type PiLogsResponse } from './inner-live.js';
import { OuterPanel } from './outer-panel.js';
import { ArchitectureGraph } from './ArchitectureGraph.js';

type Tab = 'data' | 'inner' | 'outer' | 'memory' | 'models' | 'arch';

const TENANT = 'default';

/** 已知 Agent 配置（与 vite.config.ts 代理路由对应，label 用 UTLRA_AGENT_NAME 显示名） */
const AGENTS = [
  { label: 'Kuroneko（8787）', apiPrefix: '/api' },
  { label: 'Shiro（8788）',    apiPrefix: '/api2' },
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
  '.brain/knowledge.md',
  '.brain/skills.md',
  '.brain/milestones.md',
  '.brain/constraints.md',
  '.brain/goal.md',
  '.brain/environment.md',
] as const;

const BRAIN_CORE_LABEL: Record<string, string> = {
  '.brain/knowledge.md': '知识 knowledge.md',
  '.brain/skills.md': '技能索引 skills.md',
  '.brain/milestones.md': '里程碑 milestones.md',
  '.brain/constraints.md': '约束 constraints.md',
  '.brain/goal.md': '目标 goal.md',
  '.brain/environment.md': '环境快照 environment.md',
};

function coreBrainSortKey(p: string): number {
  const i = BRAIN_CORE_FILES.indexOf(p as (typeof BRAIN_CORE_FILES)[number]);
  if (i >= 0) return i;
  if (p.startsWith('.brain/skills/') && p.endsWith('.md')) return 50 + p.length;
  return 999;
}

export function App() {
  const [tab, setTab] = useState<Tab>('data');
  const [agentIdx, setAgentIdx] = useState(0);
  const [ws, setWs] = useState('default');
  const [wsList, setWsList] = useState<string[]>(['default']);

  const agent: AgentConfig = AGENTS[agentIdx]!;
  const apiPrefix = agent.apiPrefix;

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

  return (
    <div>
      <header
        style={{
          padding: '1rem',
          borderBottom: '1px solid #2a3142',
          background: '#12151c',
        }}
      >
        <h1 style={{ margin: 0, fontSize: '1.25rem' }}>utlraKuroneko 控制台</h1>
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
          {tab !== 'inner' && tab !== 'memory' && (
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
          Agent 启动：<code>npm run dev:server</code>（Kuroneko 8787） / <code>npm run dev:agent2</code>（Shiro 8788）
        </p>
      </header>
      <div className="panel">
        <div className="tabs">
          <button type="button" className={tab === 'data' ? 'active' : ''} onClick={() => setTab('data')}>
            数据层
          </button>
          <button type="button" className={tab === 'inner' ? 'active' : ''} onClick={() => setTab('inner')}>
            内脑
          </button>
          <button type="button" className={tab === 'outer' ? 'active' : ''} onClick={() => setTab('outer')}>
            外脑
          </button>
          <button type="button" className={tab === 'memory' ? 'active' : ''} onClick={() => setTab('memory')}>
            记忆
          </button>
          <button type="button" className={tab === 'arch' ? 'active' : ''} onClick={() => setTab('arch')}>
            架构图
          </button>
          <button type="button" className={tab === 'models' ? 'active' : ''} onClick={() => setTab('models')}>
            模型测速
          </button>
        </div>
        {tab === 'data' && <DataPanel workspaceId={ws} apiPrefix={apiPrefix} />}
        {tab === 'inner' && <InnerBrainPoolPanel apiPrefix={apiPrefix} />}
        {tab === 'outer' && <OuterPanel workspaceId={ws} apiPrefix={apiPrefix} />}
        {tab === 'memory' && <MemoryPanel apiPrefix={apiPrefix} />}
        {tab === 'models' && <ModelBenchPanel apiPrefix={apiPrefix} />}
        {tab === 'arch' && (
          <div style={{ height: 'calc(100vh - 120px)', padding: 0 }}>
            <ArchitectureGraph />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Memory Panel ─────────────────────────────────────────────────────────────

function MemoryPanel({ apiPrefix }: { apiPrefix: string }) {
  const [dailyLog, setDailyLog] = useState<string>('');
  const [tasks, setTasks] = useState<string>('');
  const [tasksEdit, setTasksEdit] = useState<string>('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${apiPrefix}/outer/memory`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { dailyLog?: string; tasks?: string };
      setDailyLog(j.dailyLog ?? '');
      setTasks(j.tasks ?? '');
      if (!editing) setTasksEdit(j.tasks ?? '');
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [apiPrefix, editing]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => { void refresh(); }, 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  const handleSaveTasks = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const r = await fetch(`${apiPrefix}/outer/memory/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks_markdown: tasksEdit }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setTasks(tasksEdit);
      setEditing(false);
      setSaveMsg('已保存');
      setTimeout(() => setSaveMsg(null), 2000);
    } catch (e) {
      setSaveMsg(`保存失败：${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const pre: React.CSSProperties = {
    background: '#0d1117',
    border: '1px solid #2a3142',
    borderRadius: 6,
    padding: '0.75rem',
    fontSize: 12,
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    color: '#c8d8ff',
    minHeight: 80,
    maxHeight: 400,
    overflowY: 'auto',
  };

  return (
    <div style={{ padding: '1rem', display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
      {/* Daily Log */}
      <div style={{ flex: '1 1 340px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h3 style={{ margin: 0, fontSize: 14, color: '#8b92a8' }}>📋 每日对话日志</h3>
          <button
            type="button"
            onClick={() => { void refresh(); }}
            disabled={loading}
            style={{ fontSize: 11, padding: '2px 8px', background: '#1d2333', border: '1px solid #2a3142', borderRadius: 4, color: '#8b92a8', cursor: 'pointer' }}
          >
            {loading ? '加载中…' : '刷新'}
          </button>
        </div>
        <pre style={pre}>
          {dailyLog || '（暂无日志）'}
        </pre>
        <p style={{ margin: '4px 0 0', fontSize: 11, color: '#5a6180' }}>
          外脑每次成功回复后自动追加。路径：outer/memory/daily-log.md
        </p>
      </div>

      {/* Tasks */}
      <div style={{ flex: '1 1 340px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h3 style={{ margin: 0, fontSize: 14, color: '#8b92a8' }}>📌 当前任务状态</h3>
          <div style={{ display: 'flex', gap: 6 }}>
            {saveMsg && <span style={{ fontSize: 11, color: saveMsg.startsWith('保存失败') ? '#e06c75' : '#98c379' }}>{saveMsg}</span>}
            {!editing ? (
              <button
                type="button"
                onClick={() => { setTasksEdit(tasks); setEditing(true); }}
                style={{ fontSize: 11, padding: '2px 8px', background: '#1d2333', border: '1px solid #2a3142', borderRadius: 4, color: '#8b92a8', cursor: 'pointer' }}
              >
                编辑
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => { void handleSaveTasks(); }}
                  disabled={saving}
                  style={{ fontSize: 11, padding: '2px 8px', background: '#2a4a2a', border: '1px solid #4a7a4a', borderRadius: 4, color: '#98c379', cursor: 'pointer' }}
                >
                  {saving ? '保存中…' : '保存'}
                </button>
                <button
                  type="button"
                  onClick={() => { setEditing(false); setTasksEdit(tasks); }}
                  style={{ fontSize: 11, padding: '2px 8px', background: '#1d2333', border: '1px solid #2a3142', borderRadius: 4, color: '#8b92a8', cursor: 'pointer' }}
                >
                  取消
                </button>
              </>
            )}
          </div>
        </div>
        {editing ? (
          <textarea
            value={tasksEdit}
            onChange={(e) => setTasksEdit(e.target.value)}
            style={{
              width: '100%',
              minHeight: 240,
              background: '#0d1117',
              border: '1px solid #5b7ac5',
              borderRadius: 6,
              padding: '0.75rem',
              fontSize: 12,
              lineHeight: 1.6,
              color: '#c8d8ff',
              resize: 'vertical',
              boxSizing: 'border-box',
            }}
          />
        ) : (
          <pre style={pre}>
            {tasks || '（暂无任务状态。可点击编辑初始化，或由外脑通过 update_tasks 工具写入。）'}
          </pre>
        )}
        <p style={{ margin: '4px 0 0', fontSize: 11, color: '#5a6180' }}>
          LLM 可通过 update_tasks 工具更新。路径：outer/memory/tasks.md
        </p>
      </div>
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
            交付报告（workspace 根目录）与 Agent 脑内文件（知识 / 技能 / 里程碑）。下方可预览全文。
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
          <p className="viz-empty">尚无根目录 *.md 报告（跑完分析类里程碑后会出现）</p>
        )}

        <h3 className="viz-core-h3">Agent 脑内 · 知识与技能</h3>
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
          仅用于本地排查索引是否写入；正式闭环由外脑编排完成（<code>POST /api/outer/roundtrip</code> 的{' '}
          <code>after_burst</code> / 环境变量 <code>UTLRA_OUTER_AFTER_BURST</code>，以及{' '}
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
            尚无晋升记录（生产路径应走外脑 roundtrip / shutdown；内脑页的「晋升并关闭」为调试/手动）
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
  registry_status: 'RUNNING' | 'BLOCKED' | 'DONE' | 'STOPPED' | 'ERROR';
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

function InnerBrainPoolPanel({ apiPrefix }: { apiPrefix: string }) {
  const [instances, setInstances] = useState<InstanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null); // workspaceId
  const [stopping, setStopping] = useState<string | null>(null);
  const [restarting, setRestarting] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${apiPrefix}/inner-brains`);
      const j = (await r.json()) as { instances?: InstanceRow[] };
      setInstances(j.instances ?? []);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, [apiPrefix]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 3000);
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
            ← 返回内脑池
          </button>
          <span style={{ fontSize: 13, color: '#8b92a8' }}>当前内脑 workspace：<code>{selected}</code></span>
        </div>
        <InnerPanel workspaceId={selected} apiPrefix={apiPrefix} />
      </div>
    );
  }

  return (
    <div>
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <strong style={{ fontSize: 15 }}>内脑池</strong>
          <span style={{ fontSize: 12, color: '#8b92a8' }}>
            {loading ? '加载中…' : `共 ${instances.length} 个实例`}
          </span>
          <button type="button" style={{ marginLeft: 'auto', fontSize: 12 }} onClick={() => void refresh()}>
            刷新
          </button>
        </div>
        {err && <p style={{ color: '#f87171', fontSize: 13 }}>{err}</p>}
        {!loading && instances.length === 0 && (
          <p style={{ color: '#8b92a8', fontSize: 13 }}>
            暂无内脑实例。外脑调用 <code>set_goal</code> 工具后会在这里出现。
          </p>
        )}
        {instances.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table className="viz-advanced-table" style={{ width: '100%', fontSize: 13 }}>
              <thead>
                <tr>
                  <th>状态</th>
                  <th>实例 ID</th>
                  <th>目标（Goal）</th>
                  <th>发起方</th>
                  <th>Ticks</th>
                  <th>启动</th>
                  <th>最后 tick</th>
                  <th>耗时</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {instances.map((inst) => {
                  const color = STATUS_COLOR[inst.registry_status] ?? '#8b92a8';
                  const dur = inst.finished_at
                    ? Math.round((new Date(inst.finished_at).getTime() - new Date(inst.started_at).getTime()) / 1000) + 's'
                    : inst.registry_status === 'RUNNING' ? '运行中…' : '—';
                  return (
                    <tr key={inst.instance_id}>
                      <td>
                        <span style={{ color, fontWeight: 600, fontSize: 12 }}>
                          {inst.registry_status}
                        </span>
                        {inst.liveness === 'dead' && (
                          <span title="子进程已消失但注册表仍为 RUNNING（异常状态）" style={{ color: '#f87171', fontSize: 11, display: 'block', fontWeight: 600 }}>
                            ✕ 进程已死
                          </span>
                        )}
                        {inst.liveness === 'stuck' && (
                          <span title="距上次 tick 超过 5 分钟，可能卡死或 LLM 超长等待" style={{ color: '#fb923c', fontSize: 11, display: 'block', fontWeight: 600 }}>
                            ⚠ 可能卡住
                          </span>
                        )}
                        {inst.liveness === 'active' && (
                          <span title={inst.worker_phase ?? ''} style={{ color: '#4ade80', fontSize: 11, display: 'block' }}>
                            ● 执行中{inst.pid ? ` (pid ${inst.pid})` : ''}
                          </span>
                        )}
                        {inst.phase && (
                          <span style={{ color: '#8b92a8', fontSize: 11, display: 'block' }}>
                            {inst.phase}
                          </span>
                        )}
                      </td>
                      <td>
                        <code style={{ fontSize: 11 }}>{inst.instance_id}</code>
                      </td>
                      <td style={{ maxWidth: 280, wordBreak: 'break-word' }}>
                        {inst.goal.slice(0, 120)}{inst.goal.length > 120 ? '…' : ''}
                        {inst.error && (
                          <span style={{ color: '#f87171', display: 'block', fontSize: 11 }}>
                            {inst.error.slice(0, 80)}
                          </span>
                        )}
                      </td>
                      <td style={{ fontSize: 11, color: '#8b92a8' }}>{inst.origin_user}</td>
                      <td style={{ textAlign: 'center' }}>{inst.ticks ?? '—'}</td>
                      <td style={{ fontSize: 11, color: '#8b92a8', whiteSpace: 'nowrap' }}>
                        {timeAgo(inst.started_at)}
                      </td>
                      <td style={{ fontSize: 11, whiteSpace: 'nowrap', color: inst.liveness === 'stuck' ? '#fb923c' : '#8b92a8' }}>
                        {inst.last_tick_at ? timeAgo(inst.last_tick_at) : inst.registry_status === 'RUNNING' ? '等待首次 tick…' : '—'}
                      </td>
                      <td style={{ fontSize: 11, color: '#8b92a8', whiteSpace: 'nowrap' }}>{dur}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button
                          type="button"
                          style={{ fontSize: 11, marginRight: 6 }}
                          onClick={() => setSelected(inst.workspace_id)}
                        >
                          查看
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
                        {(inst.registry_status === 'STOPPED' || inst.registry_status === 'ERROR') && (
                          <button
                            type="button"
                            style={{ fontSize: 11, background: '#1e3a5f', borderColor: '#3b6ea5' }}
                            disabled={restarting === inst.instance_id}
                            title="从上次完成的 tick 后继续（Pi-mono 状态已持久化到磁盘）"
                            onClick={() => void restartInstance(inst.instance_id)}
                          >
                            {restarting === inst.instance_id ? '重启中…' : '继续'}
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
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// InnerPanel — 单内脑工作区详情（供 InnerBrainPoolPanel 钻取使用）
// ─────────────────────────────────────────────────────────────────────────────

function InnerPanel({ workspaceId, apiPrefix }: { workspaceId: string; apiPrefix: string }) {
  const [goal, setGoal] = useState('实现一个最小可用的内脑 tick 演示。');
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [telemetry, setTelemetry] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [llmHint, setLlmHint] = useState('');
  const [llmConfig, setLlmConfig] = useState<Record<string, unknown> | null>(null);
  const [llmResult, setLlmResult] = useState<Record<string, unknown> | null>(null);
  const [llmBusy, setLlmBusy] = useState(false);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [piMono, setPiMono] = useState<{ ready: boolean; dist?: string; hint?: string | null } | null>(null);
  const [piBusy, setPiBusy] = useState(false);
  const [piAutoBusy, setPiAutoBusy] = useState(false);
  const [piAutoMaxTicks, setPiAutoMaxTicks] = useState('500');
  const piLocked = piBusy || piAutoBusy;
  const [brainInsp, setBrainInsp] = useState<BrainInspector | null>(null);
  const [piLogs, setPiLogs] = useState<PiLogsResponse | null>(null);
  const [insightLoaded, setInsightLoaded] = useState(false);
  const [insightErr, setInsightErr] = useState<string | null>(null);
  const [suggestPromoteShutdown, setSuggestPromoteShutdown] = useState(false);
  const [promoteBusy, setPromoteBusy] = useState(false);

  const pull = useCallback(async () => {
    const [s, t] = await Promise.all([
      fetch(`${apiPrefix}/inner/${workspaceId}/status`).then((r) => r.json()),
      fetch(`${apiPrefix}/inner/${workspaceId}/telemetry`).then((r) => r.json()),
    ]);
    setStatus(s.status as Record<string, unknown>);
    setTelemetry(t.lines as string[]);
  }, [workspaceId]);

  const pullInsight = useCallback(async () => {
    try {
      setInsightErr(null);
      const [rb, rl] = await Promise.all([
        fetch(`${apiPrefix}/inner/${workspaceId}/brain-inspector`),
        fetch(`${apiPrefix}/inner/${workspaceId}/pi-logs?limit=150`),
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
  }, [workspaceId]);

  useEffect(() => {
    const id = setInterval(() => void pull(), 2000);
    void pull();
    return () => clearInterval(id);
  }, [pull]);

  useEffect(() => {
    const ms = piBusy ? 450 : 2200;
    const id = setInterval(() => void pullInsight(), ms);
    void pullInsight();
    return () => clearInterval(id);
  }, [piBusy, pullInsight]);

  useEffect(() => {
    void fetch(`${apiPrefix}/llm/config`)
      .then((r) => r.json())
      .then(setLlmConfig)
      .catch(() => setLlmConfig(null));
  }, [apiPrefix]);

  useEffect(() => {
    void fetch(`${apiPrefix}/inner/${workspaceId}/pi-mono`)
      .then((r) => r.json())
      .then(setPiMono)
      .catch(() => setPiMono({ ready: false, hint: '无法连接 API' }));
  }, [apiPrefix, workspaceId]);

  const readImageAsBase64 = (file: File): Promise<{ b64: string; mime: string }> =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const s = String(r.result ?? '');
        const m = s.match(/^data:([^;]+);base64,(.+)$/);
        if (m) resolve({ mime: m[1]!, b64: m[2]! });
        else reject(new Error('invalid data url'));
      };
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });

  const phase = (status?.phase as string) ?? 'idle';
  const badgeClass =
    phase === 'executing' ? 'executing' : phase === 'planning' ? 'planning' : 'idle';

  const tickCount = Number(status?.tickCount ?? 0);
  const lastAction = String(status?.lastAction ?? '');
  /** 仅写入 Goal、从未点过 tick / pi-tick 时，phase 会一直是 planning 且计数为 0 —— 这是预期行为 */
  const waitingForFirstTick =
    lastAction === 'goal_set' && tickCount === 0 && phase === 'planning';

  return (
    <div>
      {err && <div className="card" style={{ color: '#f0a8a8' }}>{err}</div>}
      {insightErr && (
        <div className="card" style={{ color: '#f0a8a8', borderColor: '#6b3030' }}>
          内脑实况接口失败：{insightErr}（请确认已重启 API、且代理指向 8787）
        </div>
      )}
      <InnerLiveDeck
        brain={brainInsp}
        logs={piLogs}
        piBusy={piLocked}
        insightLoading={!insightLoaded}
      />
      {waitingForFirstTick && (
        <div className="card inner-nudge">
          <strong>内脑还没开始跑任务</strong>
          <p>
            你已<strong>设置 Goal</strong>，但还没有跑 <strong>Pi-mono</strong>。当前 <code>planning</code> 只表示「已记目标」；
            需要点击下方 <strong>Pi-mono tick</strong> 或 <strong>Pi-mono Auto</strong>（需配置智谱等 API Key）。
          </p>
        </div>
      )}
      {suggestPromoteShutdown && (
        <div className="card inner-nudge" style={{ borderColor: '#3d5a80' }}>
          <strong>[调试] 建议：manifest 晋升并关闭内脑</strong>
          <p style={{ marginBottom: 10 }}>
            正式流程请用外脑：<code>POST /api/outer/roundtrip</code>（配 <code>after_burst: &quot;promote_and_shutdown_if_complete&quot;</code> 或环境变量）或{' '}
            <code>POST /api/outer/workspace/{workspaceId}/shutdown</code>（<code>promote_manifest: true</code>）。
            此处按钮等价于内脑侧 <code>promote-and-shutdown</code>，便于本地验证。
          </p>
          <button
            type="button"
            disabled={promoteBusy}
            onClick={async () => {
              if (
                !confirm(
                  '将 manifest 内容晋升到 Repository，然后关闭内脑（SLEEPING）？\n\n' +
                    '可在数据层刷新查看执行轨记录。',
                )
              ) {
                return;
              }
              setErr(null);
              setPromoteBusy(true);
              try {
                const r = await fetch(`${apiPrefix}/inner/${workspaceId}/promote-and-shutdown`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ tenant_id: TENANT }),
                });
                const j = (await r.json()) as { ok?: boolean; error?: string };
                if (!r.ok) setErr(j.error ?? (await r.text()));
                else {
                  setSuggestPromoteShutdown(false);
                  void pull();
                  void pullInsight();
                }
              } finally {
                setPromoteBusy(false);
              }
            }}
          >
            {promoteBusy ? '晋升并关闭中…' : '晋升 manifest 并关闭内脑'}
          </button>
        </div>
      )}
      <div className="card">
        <strong>Goal（.brain/goal.md，与 openKuroneko 一致）</strong>
        <textarea rows={5} value={goal} onChange={(e) => setGoal(e.target.value)} style={{ marginTop: 8 }} />
        <div className="row" style={{ marginTop: 8 }}>
          <button
            type="button"
            onClick={async () => {
              setErr(null);
              const r = await fetch(`${apiPrefix}/inner/${workspaceId}/goal`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ goal }),
              });
              if (!r.ok) setErr(await r.text());
              else {
                void pull();
                void pullInsight();
              }
            }}
          >
            设置 Goal
          </button>
          <button type="button" onClick={() => void pull()}>
            刷新状态
          </button>
          <button
            type="button"
            disabled={!piMono?.ready || piLocked}
            title={piMono?.hint ?? ''}
            onClick={async () => {
              setErr(null);
              setPiBusy(true);
              try {
                const r = await fetch(`${apiPrefix}/inner/${workspaceId}/pi-tick`, { method: 'POST' });
                const j = (await r.json()) as {
                  ok?: boolean;
                  error?: string;
                  suggestPromoteShutdown?: boolean;
                };
                if (!r.ok) setErr(j.error ?? await r.text());
                else {
                  setSuggestPromoteShutdown(!!j.suggestPromoteShutdown);
                  void pull();
                  void pullInsight();
                }
              } finally {
                setPiBusy(false);
              }
            }}
          >
            {piBusy ? 'Pi-mono 单步…' : 'Pi-mono 单步 tick'}
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            Auto 上限
            <input
              type="number"
              min={1}
              max={10000}
              value={piAutoMaxTicks}
              onChange={(e) => setPiAutoMaxTicks(e.target.value)}
              style={{ width: 88, margin: 0 }}
            />
          </label>
          <button
            type="button"
            disabled={!piMono?.ready || piLocked}
            title={piMono?.hint ?? ''}
            onClick={async () => {
              const maxTicks = Math.min(10000, Math.max(1, parseInt(piAutoMaxTicks, 10) || 500));
              if (
                !confirm(
                  `Pi-mono Auto：同一请求内最多连续执行 ${maxTicks} 次控制器 tick，直到本轮「无活」或达到上限。可能耗时很长，确定？`,
                )
              ) {
                return;
              }
              setErr(null);
              setPiAutoBusy(true);
              try {
                const r = await fetch(`${apiPrefix}/inner/${workspaceId}/pi-auto`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ maxTicks }),
                });
                const j = (await r.json()) as {
                  ok?: boolean;
                  error?: string;
                  ticks?: number;
                  stoppedBy?: string;
                  suggestPromoteShutdown?: boolean;
                };
                if (!r.ok) setErr(j.error ?? await r.text());
                else {
                  setSuggestPromoteShutdown(!!j.suggestPromoteShutdown);
                  void pull();
                  void pullInsight();
                }
              } finally {
                setPiAutoBusy(false);
              }
            }}
          >
            {piAutoBusy ? 'Pi-mono Auto 运行中…' : 'Pi-mono Auto（跑到空闲）'}
          </button>
          <button
            type="button"
            className="danger"
            title="清空 .brain 与 .run 下 Pi/遥测/manifest 等，便于从零重测"
            onClick={async () => {
              if (
                !confirm(
                  '完全清空内脑状态并重新测试？\n\n' +
                    '将删除 Goal；清空里程碑/约束/知识/技能/环境；控制器回到 DECOMPOSE；\n' +
                    '删除 .run/pi-mono（含日志与 deliverables）、遥测 trace、LLM 缓存；\n' +
                    '重置 manifest。\n\n' +
                    '不会删除 workspace 根目录的报告文件与 .tool-outputs。',
                )
              ) {
                return;
              }
              setErr(null);
              const r = await fetch(`${apiPrefix}/inner/${workspaceId}/reset`, { method: 'POST' });
              const j = (await r.json()) as { ok?: boolean; error?: string };
              if (!r.ok) setErr(j.error ?? (await r.text()));
              else {
                void pull();
                void pullInsight();
              }
            }}
          >
            完全清空（重新测试）
          </button>
          <button
            type="button"
            className="danger"
            title="将 Pi-mono 控制器置为休眠（SLEEPING），不删 Goal；之后可再 tick 或外脑唤醒"
            onClick={async () => {
              if (
                !confirm(
                  '关闭内脑？\n\n将把控制器置为休眠（长期睡眠），并清除未完成的 execution-context。\nGoal 与里程碑文件不会删除。',
                )
              ) {
                return;
              }
              setErr(null);
              const r = await fetch(`${apiPrefix}/inner/${workspaceId}/brain-shutdown`, { method: 'POST' });
              const j = (await r.json()) as { ok?: boolean; error?: string };
              if (!r.ok) setErr(j.error ?? (await r.text()));
              else {
                void pull();
                void pullInsight();
              }
            }}
          >
            关闭内脑
          </button>
        </div>
        <p style={{ fontSize: 12, color: '#8b92a8', marginTop: 12, lineHeight: 1.5 }}>
          <strong>单步粒度</strong>：一次 <code>Pi-mono 单步</code> = 内嵌 Pi-mono 控制器的<strong>一次</strong>{' '}
          <code>Controller.tick()</code>（一个<strong>宏步</strong>）。例如 DECOMPOSE 里会跑完一整次 Decomposer（通常一次
          LLM）；EXECUTE 里可能包含<strong>多轮</strong> LLM + 工具，直到 Executor 本轮结束再进入 ATTRIBUTE。
          <strong>Auto</strong> 则在<strong>同一连接内</strong>连续 tick，直到某次 <code>hadWork=false</code>（本轮无事可做）或达到「Auto
          上限」——不等于「整个项目永远跑完」；若遇 BLOCKED / 休眠，仍需外脑输入或再点 Auto。
        </p>
        {piMono && !piMono.ready && (
          <p style={{ fontSize: 12, color: '#c9a227', marginTop: 8 }}>
            Pi-mono 未就绪：{piMono.hint ?? '请检查 API 服务'}
            {piMono.dist ? ` · runtime=${piMono.dist}` : ''}
          </p>
        )}
      </div>
      <div className="card">
        <strong>智谱 LLM（编码套餐端点：文本 glm-5.1 / 附图单次 glm-5v-turbo）</strong>
        <pre style={{ fontSize: 12, marginTop: 8, maxHeight: 120, overflow: 'auto' }}>
          {JSON.stringify(llmConfig, null, 2)}
        </pre>
        <label style={{ display: 'block', marginTop: 8, fontSize: 13 }}>本轮补充（可选）</label>
        <textarea rows={2} value={llmHint} onChange={(e) => setLlmHint(e.target.value)} />
        <label style={{ display: 'block', marginTop: 8, fontSize: 13 }}>附图（可选，走 ZHIPU_VISION_MODEL）</label>
        <input
          type="file"
          accept="image/*"
          onChange={(e) => setImageFile(e.target.files?.[0] ?? null)}
        />
        <div className="row" style={{ marginTop: 8 }}>
          <button
            type="button"
            disabled={llmBusy || !llmConfig?.configured}
            onClick={async () => {
              setErr(null);
              setLlmBusy(true);
              setLlmResult(null);
              try {
                let imageBase64: string | undefined;
                let mimeType: string | undefined;
                if (imageFile) {
                  const { b64, mime } = await readImageAsBase64(imageFile);
                  imageBase64 = b64;
                  mimeType = mime;
                }
                const r = await fetch(`${apiPrefix}/inner/${workspaceId}/llm-step`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    userHint: llmHint || undefined,
                    imageBase64,
                    mimeType,
                  }),
                });
                const j = await r.json();
                setLlmResult(j);
                if (!r.ok) setErr((j.error as string) ?? r.statusText);
                void pull();
              } catch (e) {
                setErr(String(e));
              } finally {
                setLlmBusy(false);
              }
            }}
          >
            {llmBusy ? '请求中…' : 'LLM 一步'}
          </button>
          {!llmConfig?.configured && (
            <span style={{ fontSize: 13, color: '#c9a227' }}>未配置 ZHIPU_API_KEY（见 .env.example）</span>
          )}
        </div>
        {llmResult && (
          <pre style={{ marginTop: 12, overflow: 'auto', maxHeight: 280, fontSize: 12 }}>
            {JSON.stringify(llmResult, null, 2)}
          </pre>
        )}
      </div>

      <div className="card">
        <strong>工作状态（utlra 聚合 · 与 Pi-mono 模式不同源）</strong>
        <div style={{ marginTop: 8 }}>
          <span className={`badge ${badgeClass}`}>{phase}</span>
        </div>
        <pre style={{ overflow: 'auto', marginTop: 12 }}>{JSON.stringify(status, null, 2)}</pre>
      </div>
      <div className="card">
        <strong>遥测尾部（.run/telemetry/trace.jsonl）</strong>
        <pre style={{ overflow: 'auto', maxHeight: 240, fontSize: 11, marginTop: 8 }}>
          {telemetry.length ? telemetry.join('\n') : '（空）'}
        </pre>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
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

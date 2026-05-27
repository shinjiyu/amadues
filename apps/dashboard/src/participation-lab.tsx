import { useCallback, useEffect, useMemo, useState } from 'react';

type ThreadKind = 'dm' | 'group';
type LlmMode = 'none' | 'mock' | 'real';

export interface ParticipationPreset {
  id: string;
  label: string;
  category: string;
  description?: string;
  threadId: string;
  content: string;
  meta: {
    threadKind: ThreadKind;
    isMentionAgent: boolean;
    mentionsOthers: boolean;
    skipParticipationCheck: boolean;
  };
  proactiveLevel: number;
  threadHistoryPrefix: string;
  innerStatusSummary: string;
  config?: {
    proactiveLevel?: number;
    speakCooldownMs?: number;
    maxProactivePer5Min?: number;
    useLlmForParticipation?: boolean;
  };
  mockLlmContent?: string;
  expect?: { shouldReply: boolean; reason?: string };
}

interface EvaluateResult {
  threadId: string;
  llmMode?: string;
  sync: { shouldReply: boolean; reason: string };
  final: { shouldReply: boolean; reason: string };
  productionFinal?: { shouldReply: boolean; reason: string };
  usedLlm: boolean;
  llmRaw: string | null;
  path: string[];
  config?: Record<string, unknown>;
  presetId?: string;
  expect?: { shouldReply: boolean; reason?: string };
}

const STORAGE_KEY = 'utlra-participation-lab-custom';

interface CustomCase {
  name: string;
  savedAt: string;
  payload: Record<string, unknown>;
}

const defaultForm = () => ({
  threadId: `participation-lab:custom:${Date.now()}`,
  content: '我刚搭好开发环境，构建挺顺利',
  threadKind: 'group' as ThreadKind,
  isMentionAgent: false,
  mentionsOthers: false,
  skipParticipationCheck: false,
  proactiveLevel: 2,
  threadHistoryPrefix: 'Alice: 早上好\nBob: 早',
  innerStatusSummary: '内脑 idle',
  speakCooldownMs: 60_000,
  maxProactivePer5Min: 8,
  useLlmForParticipation: true,
  llmMode: 'mock' as LlmMode,
  mockLlmContent: 'SILENT',
  resetThreadState: true,
});

function loadCustomCases(): CustomCase[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as CustomCase[];
  } catch {
    return [];
  }
}

function saveCustomCases(cases: CustomCase[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cases));
}

export function ParticipationLabPanel({ apiPrefix }: { apiPrefix: string }) {
  const [presets, setPresets] = useState<ParticipationPreset[]>([]);
  const [form, setForm] = useState(defaultForm);
  const [result, setResult] = useState<EvaluateResult | null>(null);
  const [batch, setBatch] = useState<Array<{ id: string; label: string; ok: boolean; result: EvaluateResult }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [llmConfigured, setLlmConfigured] = useState<boolean | null>(null);
  const [customCases, setCustomCases] = useState<CustomCase[]>(() => loadCustomCases());
  const [filter, setFilter] = useState('');

  useEffect(() => {
    void fetch(`${apiPrefix}/dev/participation/presets`)
      .then((r) => r.json())
      .then((j: { presets?: ParticipationPreset[] }) => setPresets(j.presets ?? []))
      .catch((e) => setError(String(e)));
    void fetch(`${apiPrefix}/llm/config`)
      .then((r) => r.json())
      .then((j: { configured?: boolean }) => setLlmConfigured(!!j.configured))
      .catch(() => setLlmConfigured(false));
  }, [apiPrefix]);

  const buildPayload = useCallback(() => {
    return {
      threadId: form.threadId,
      content: form.content,
      meta: {
        threadKind: form.threadKind,
        isMentionAgent: form.isMentionAgent,
        mentionsOthers: form.mentionsOthers,
        skipParticipationCheck: form.skipParticipationCheck,
      },
      proactiveLevel: form.proactiveLevel,
      threadHistoryPrefix: form.threadHistoryPrefix,
      innerStatusSummary: form.innerStatusSummary,
      config: {
        proactiveLevel: form.proactiveLevel as 0 | 1 | 2 | 3,
        speakCooldownMs: form.speakCooldownMs,
        maxProactivePer5Min: form.maxProactivePer5Min,
        useLlmForParticipation: form.useLlmForParticipation,
      },
      llmMode: form.llmMode,
      mockLlmContent: form.mockLlmContent,
      resetThreadState: form.resetThreadState,
    };
  }, [form]);

  const runEvaluate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${apiPrefix}/dev/participation/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      });
      const j = (await r.json()) as EvaluateResult & { error?: string };
      if (!r.ok) throw new Error(j.error ?? r.statusText);
      setResult(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [apiPrefix, buildPayload]);

  const loadPreset = (p: ParticipationPreset) => {
    setForm({
      threadId: `${p.threadId}:${Date.now()}`,
      content: p.content,
      threadKind: p.meta.threadKind,
      isMentionAgent: p.meta.isMentionAgent,
      mentionsOthers: p.meta.mentionsOthers,
      skipParticipationCheck: p.meta.skipParticipationCheck,
      proactiveLevel: p.proactiveLevel,
      threadHistoryPrefix: p.threadHistoryPrefix,
      innerStatusSummary: p.innerStatusSummary,
      speakCooldownMs: p.config?.speakCooldownMs ?? 60_000,
      maxProactivePer5Min: p.config?.maxProactivePer5Min ?? 8,
      useLlmForParticipation: p.config?.useLlmForParticipation ?? true,
      llmMode: p.mockLlmContent || p.category === 'group-llm' ? 'mock' : 'none',
      mockLlmContent: p.mockLlmContent ?? 'SILENT',
      resetThreadState: true,
    });
    setResult(null);
  };

  const runPreset = async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${apiPrefix}/dev/participation/run-preset/${id}?mock=1`, { method: 'POST' });
      const j = (await r.json()) as EvaluateResult & { error?: string };
      if (!r.ok) throw new Error(j.error ?? r.statusText);
      setResult(j);
      const preset = presets.find((p) => p.id === id);
      if (preset) loadPreset(preset);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const runAllPresets = async () => {
    setLoading(true);
    setError(null);
    const rows: Array<{ id: string; label: string; ok: boolean; result: EvaluateResult }> = [];
    try {
      for (const p of presets) {
        const r = await fetch(`${apiPrefix}/dev/participation/run-preset/${p.id}?mock=1`, { method: 'POST' });
        const j = (await r.json()) as EvaluateResult & { error?: string; expect?: ParticipationPreset['expect'] };
        if (!r.ok) throw new Error(j.error ?? p.id);
        const ok =
          !p.expect ||
          (j.final.shouldReply === p.expect.shouldReply &&
            (!p.expect.reason || j.final.reason === p.expect.reason));
        rows.push({ id: p.id, label: p.label, ok, result: j });
      }
      setBatch(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const saveCustom = () => {
    const name = window.prompt('用例名称', `自定义 ${new Date().toLocaleString()}`);
    if (!name?.trim()) return;
    const next = [
      { name: name.trim(), savedAt: new Date().toISOString(), payload: buildPayload() as Record<string, unknown> },
      ...customCases,
    ].slice(0, 30);
    setCustomCases(next);
    saveCustomCases(next);
  };

  const loadCustom = (c: CustomCase) => {
    const p = c.payload as ReturnType<typeof buildPayload> & {
      meta?: { threadKind?: ThreadKind; isMentionAgent?: boolean; mentionsOthers?: boolean; skipParticipationCheck?: boolean };
      config?: { speakCooldownMs?: number; maxProactivePer5Min?: number; useLlmForParticipation?: boolean };
    };
    setForm({
      ...defaultForm(),
      threadId: String(p.threadId ?? defaultForm().threadId),
      content: String(p.content ?? ''),
      threadKind: p.meta?.threadKind ?? 'group',
      isMentionAgent: !!p.meta?.isMentionAgent,
      mentionsOthers: !!p.meta?.mentionsOthers,
      skipParticipationCheck: !!p.meta?.skipParticipationCheck,
      proactiveLevel: Number(p.proactiveLevel ?? 2),
      threadHistoryPrefix: String(p.threadHistoryPrefix ?? ''),
      innerStatusSummary: String(p.innerStatusSummary ?? ''),
      speakCooldownMs: p.config?.speakCooldownMs ?? 60_000,
      maxProactivePer5Min: p.config?.maxProactivePer5Min ?? 8,
      useLlmForParticipation: p.config?.useLlmForParticipation ?? true,
      llmMode: (p.llmMode as LlmMode) ?? 'mock',
      mockLlmContent: String(p.mockLlmContent ?? 'SILENT'),
      resetThreadState: p.resetThreadState !== false,
    });
  };

  const filteredPresets = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return presets;
    return presets.filter(
      (p) =>
        p.label.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q),
    );
  }, [presets, filter]);

  const expectMatch =
    result?.expect &&
    result.final.shouldReply === result.expect.shouldReply &&
    (!result.expect.reason || result.final.reason === result.expect.reason);

  return (
    <div className="participation-lab">
      <p className="participation-lab-intro">
        可视化 <code>participationPolicy</code>（<code>inbound-policy.ts</code>）的「是否说话」决策。
        <strong>选 Mock / 真实 LLM 时必定调用</strong> <code>participationSpeakLlm</code>（同步规则仅展示；另附生产路径对比）。
        选「不调 LLM」则只跑同步规则。API：<code>POST {apiPrefix}/dev/participation/evaluate</code>
        {llmConfigured === false && (
          <span className="participation-warn"> · 未配置 LLM key，「真实 LLM」不可用</span>
        )}
      </p>

      <div className="participation-lab-layout">
        <aside className="participation-sidebar">
          <input
            placeholder="筛选预设…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="participation-preset-list">
            {filteredPresets.map((p) => (
              <button
                key={p.id}
                type="button"
                className="participation-preset-btn"
                onClick={() => loadPreset(p)}
                title={p.description ?? p.id}
              >
                <span className="cat">{p.category}</span>
                {p.label}
              </button>
            ))}
          </div>
          <div className="participation-sidebar-actions">
            <button type="button" disabled={loading} onClick={() => void runAllPresets()}>
              批量跑预设
            </button>
          </div>
          {customCases.length > 0 && (
            <>
              <h4>已保存用例</h4>
              <div className="participation-preset-list">
                {customCases.map((c) => (
                  <button key={c.savedAt + c.name} type="button" className="participation-preset-btn" onClick={() => loadCustom(c)}>
                    <span className="cat">custom</span>
                    {c.name}
                  </button>
                ))}
              </div>
            </>
          )}
        </aside>

        <main className="participation-main">
          <div className="participation-form-grid">
            <label>
              threadId
              <input value={form.threadId} onChange={(e) => setForm({ ...form, threadId: e.target.value })} />
            </label>
            <label>
              threadKind
              <select
                value={form.threadKind}
                onChange={(e) => setForm({ ...form, threadKind: e.target.value as ThreadKind })}
              >
                <option value="dm">dm</option>
                <option value="group">group</option>
              </select>
            </label>
            <label>
              proactiveLevel
              <select
                value={form.proactiveLevel}
                onChange={(e) => setForm({ ...form, proactiveLevel: Number(e.target.value) })}
              >
                {[0, 1, 2, 3].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            <label className="participation-check">
              <input type="checkbox" checked={form.isMentionAgent} onChange={(e) => setForm({ ...form, isMentionAgent: e.target.checked })} />
              @ 本 agent
            </label>
            <label className="participation-check">
              <input type="checkbox" checked={form.mentionsOthers} onChange={(e) => setForm({ ...form, mentionsOthers: e.target.checked })} />
              @ 他人
            </label>
            <label className="participation-check">
              <input
                type="checkbox"
                checked={form.skipParticipationCheck}
                onChange={(e) => setForm({ ...form, skipParticipationCheck: e.target.checked })}
              />
              skipParticipationCheck
            </label>
            <label className="span-2">
              消息正文 content
              <textarea rows={3} value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} />
            </label>
            <label className="span-2">
              线程历史 threadHistoryPrefix
              <textarea rows={2} value={form.threadHistoryPrefix} onChange={(e) => setForm({ ...form, threadHistoryPrefix: e.target.value })} />
            </label>
            <label className="span-2">
              内脑摘要 innerStatusSummary
              <textarea rows={2} value={form.innerStatusSummary} onChange={(e) => setForm({ ...form, innerStatusSummary: e.target.value })} />
            </label>
            <label>
              评估路径
              <select
                value={form.llmMode}
                onChange={(e) => {
                  const llmMode = e.target.value as LlmMode;
                  setForm({
                    ...form,
                    llmMode,
                    useLlmForParticipation: llmMode !== 'none',
                  });
                }}
              >
                <option value="none">仅同步规则（不调 LLM）</option>
                <option value="mock">Mock LLM（强制调用）</option>
                <option value="real" disabled={llmConfigured === false}>
                  真实 LLM（强制调用）
                </option>
              </select>
            </label>
            {form.llmMode === 'mock' && (
              <label>
                Mock 正文
                <input value={form.mockLlmContent} onChange={(e) => setForm({ ...form, mockLlmContent: e.target.value })} />
              </label>
            )}
            <label className="participation-check">
              <input
                type="checkbox"
                checked={form.resetThreadState}
                onChange={(e) => setForm({ ...form, resetThreadState: e.target.checked })}
              />
              评估前清空频控
            </label>
            <label className="participation-check">
              <input
                type="checkbox"
                checked={form.useLlmForParticipation}
                onChange={(e) => setForm({ ...form, useLlmForParticipation: e.target.checked })}
              />
              useLlmForParticipation
            </label>
          </div>

          <div className="participation-actions">
            <button type="button" className="primary" disabled={loading} onClick={() => void runEvaluate()}>
              {loading ? '评估中…' : '运行评估'}
            </button>
            <button type="button" disabled={loading} onClick={saveCustom}>
              保存到本地
            </button>
            <button
              type="button"
              disabled={loading}
              onClick={() => {
                void fetch(`${apiPrefix}/dev/participation/reset-state`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({}),
                });
              }}
            >
              清空全部频控
            </button>
          </div>

          {error && <div className="participation-error">{error}</div>}

          {result && (
            <div className={`participation-result ${result.final.shouldReply ? 'speak' : 'silent'}`}>
              <div className="participation-verdict">
                {result.final.shouldReply ? 'SPEAK · 应回复' : 'SILENT · 不参与'}
                <code>{result.final.reason}</code>
              </div>
              {result.expect && (
                <div className={expectMatch ? 'participation-expect ok' : 'participation-expect fail'}>
                  预设期望：{result.expect.shouldReply ? 'SPEAK' : 'SILENT'}
                  {result.expect.reason ? ` · ${result.expect.reason}` : ''}
                  {expectMatch ? ' ✓' : ' ✗'}
                </div>
              )}
              <div className="participation-path">
                {result.path.map((step, i) => (
                  <span key={i}>{step}</span>
                ))}
              </div>
              {result.llmRaw != null && result.llmRaw !== '(见服务端日志)' && (
                <div className="participation-llm-raw">
                  LLM 原文：<code>{result.llmRaw}</code>
                </div>
              )}
              <pre>
                {JSON.stringify(
                  {
                    sync: result.sync,
                    final: result.final,
                    productionFinal: result.productionFinal,
                    usedLlm: result.usedLlm,
                    llmRaw: result.llmRaw,
                    config: result.config,
                  },
                  null,
                  2,
                )}
              </pre>
            </div>
          )}

          {batch.length > 0 && (
            <div className="participation-batch">
              <h4>批量结果 ({batch.filter((b) => b.ok).length}/{batch.length} 通过)</h4>
              <table>
                <thead>
                  <tr>
                    <th>用例</th>
                    <th>结果</th>
                    <th>reason</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {batch.map((b) => (
                    <tr key={b.id} className={b.ok ? 'ok' : 'fail'}>
                      <td>{b.label}</td>
                      <td>{b.result.final.shouldReply ? 'SPEAK' : 'SILENT'}</td>
                      <td><code>{b.result.final.reason}</code></td>
                      <td>
                        <button type="button" onClick={() => { setResult(b.result); void runPreset(b.id); }}>
                          查看
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

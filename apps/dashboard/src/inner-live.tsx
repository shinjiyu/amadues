/**
 * 内脑实况 UI：对齐 openKuroneko chat-ui Monitor（模式徽章、里程碑、结构化日志）。
 */

export type PiMonoTickExplained = {
  summary: string;
  modes: Array<{ mode: string; what: string }>;
  note: string;
};

export type BrainInspector = {
  controllerState: Record<string, unknown> | null;
  goalText: string;
  milestonesText: string;
  paths: {
    brainDir: boolean;
    controllerState: boolean;
    milestones: boolean;
    executionContext?: boolean;
  };
  /** EXECUTE 结束、ATTRIBUTE 尚未删文件时存在；含 executionLog 摘要 */
  executionContextPreview?: Record<string, unknown> | null;
  logHighlights?: {
    lastAttributor: { ts?: unknown; flag?: unknown; reason?: unknown } | null;
    lastDecomposer: { ts?: unknown; data?: unknown } | null;
    lastControllerTickStart: { ts?: unknown; data?: unknown } | null;
  };
  piMonoTickExplained?: PiMonoTickExplained;
};

export type PiLogsResponse = {
  entries: Record<string, unknown>[];
  source: string | null;
  hint?: string;
  count?: number;
};

export type MilestoneRow = {
  id: string;
  status: string;
  title: string;
  desc: string;
  /** milestones.md 中标题行下的 `> 标签：…` 约定（与 openKuroneko 解析一致） */
  contract?: string;
};

function parseMilestoneHeaderLine(trimmed: string): MilestoneRow | null {
  const cy = trimmed.match(
    /^\s*\[(\w+)\]\s+\[(Active|Pending|Completed)\]\s+\[cyclic:\d+\]\s+(.+?)\s+[—–-]\s+(.+)\s*$/u,
  );
  if (cy) {
    return { id: cy[1]!, status: cy[2]!, title: cy[3]!.trim(), desc: cy[4]!.trim() };
  }
  const m = trimmed.match(/^\s*\[(\w+)\]\s+\[(Active|Pending|Completed)\]\s+(.+?)\s+[—–-]\s+(.+)\s*$/u);
  if (m) {
    return { id: m[1]!, status: m[2]!, title: m[3]!.trim(), desc: m[4]!.trim() };
  }
  return null;
}

/** 解析 milestones.md：正文行 + 紧随的 `> …` 契约行（openKuroneko 同格式） */
export function parseMilestones(raw: string): MilestoneRow[] {
  const items: MilestoneRow[] = [];
  let cur: MilestoneRow | null = null;
  for (const rawLine of raw.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

    if (/^\s*[>›]/.test(trimmed)) {
      if (!cur) continue;
      const stripped = trimmed.replace(/^\s*[>›]\s*/, '').trim();
      cur.contract = cur.contract ? `${cur.contract}\n${stripped}` : stripped;
      continue;
    }

    const row = parseMilestoneHeaderLine(trimmed);
    if (row) {
      items.push(row);
      cur = row;
    }
  }
  return items;
}

/** 将 openKuroneko Logger JSON 行译为简短中文（便于「当前在干什么」） */
export function describePiLogEntry(e: Record<string, unknown>): string {
  if (e['_parseError']) return '（日志行解析失败）';
  const mod = String(e['module'] ?? '');
  const ev = String(e['event'] ?? '');
  const data = e['data'] as Record<string, unknown> | undefined;

  if (mod === 'executor' && ev === 'llm.call') {
    const round = data?.['round'];
    return `Executor：正在调用 LLM${round !== undefined ? `（轮次 ${round}）` : ''}…`;
  }
  if (mod === 'executor' && ev === 'llm.done') return 'Executor：LLM 本轮回复结束';
  if (mod === 'executor' && ev === 'llm.error') return `Executor：LLM 错误 — ${String(data?.['error'] ?? '').slice(0, 120)}`;
  if (mod === 'executor' && ev === 'tool.call') {
    const name = String(data?.['name'] ?? '?');
    return `Executor：调用工具 ${name}`;
  }
  if (mod === 'executor' && ev === 'tool.result') {
    const name = String(data?.['name'] ?? '?');
    const ok = data?.['ok'] === true;
    return `Executor：工具 ${name} ${ok ? '返回' : '失败'}`;
  }
  if (mod === 'executor' && ev === 'execute.start') {
    const id = data?.['milestoneId'] ?? data?.['title'];
    return `Executor：开始执行里程碑 ${String(id ?? '')}`.trim();
  }
  if (mod === 'executor' && ev === 'execute.done') return 'Executor：本段执行循环结束';

  if (mod === 'decomposer' && ev === 'decompose.start') return 'Decomposer：正在生成里程碑（LLM）…';
  if (mod === 'decomposer' && (ev === 'decompose.done' || ev.includes('decompose'))) return 'Decomposer：里程碑已写入';

  if (mod === 'controller' && ev === 'tick.start') {
    const mode = data?.['mode'];
    return `控制器：tick 开始${mode !== undefined ? `（当前模式 ${mode}）` : ''}`;
  }
  if (mod === 'controller' && ev.includes('decompose')) return `控制器：${ev}`;
  if (mod === 'controller' && ev.includes('blocked')) return `控制器：阻塞 — ${ev}`;

  if (mod === 'attributor') {
    if (ev === 'attribute.done') {
      const flag = data?.['flag'];
      const reason = String(data?.['reason'] ?? '').slice(0, 200);
      return `Attributor：归因结论 — flag=${String(flag ?? '')}${reason ? `；${reason}` : ''}`;
    }
    if (ev.includes('start')) return 'Attributor：归因分析（LLM）…';
    if (ev.includes('done') || ev.includes('complete')) return 'Attributor：归因完成';
  }

  if (!mod && !ev) return JSON.stringify(e).slice(0, 80);
  return `${mod} · ${ev}`;
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
  /** 首次 brain-inspector / pi-logs 请求尚未结束 */
  insightLoading?: boolean;
}) {
  const st = brain?.controllerState;
  const rawMode = String(st?.['mode'] ?? '—');
  const piModes = ['DECOMPOSE', 'EXECUTE', 'ATTRIBUTE', 'BLOCKED', 'SLEEPING'];
  const modeClass = piModes.includes(rawMode) ? rawMode : 'unknown';
  const mode = rawMode;
  const replanCount = Number(st?.['replanCount'] ?? 0);
  const blockedReason = st?.['blockedReason'] != null ? String(st['blockedReason']) : '';
  const sleepUntil = st?.['sleepUntil'] != null ? String(st['sleepUntil']) : '';

  const ms = brain ? parseMilestones(brain.milestonesText) : [];
  const entries = logs?.entries ?? [];
  const last = entries.length ? (entries[entries.length - 1] as Record<string, unknown>) : null;
  const lastHuman = last ? describePiLogEntry(last) : '（尚无 Pi-mono 日志）';

  const explained = brain?.piMonoTickExplained;
  const lh = brain?.logHighlights;
  const lastAttr = lh?.lastAttributor;
  const exPrev = brain?.executionContextPreview;
  const hasExecCtx = Boolean(brain?.paths.executionContext && exPrev && !exPrev['_parseError']);

  return (
    <div className="card inner-live">
      <div className="inner-live-title-row">
        <strong className="inner-live-title">内脑实况</strong>
        <span className="inner-live-title-tag">模式 · 归因 · 里程碑 · Goal</span>
      </div>
      {insightLoading && <div className="inner-live-loading">正在拉取状态…</div>}
      <p className="inner-live-hint inner-live-hint-short">
        模式、归因、里程碑与 Goal 概览；原始日志在底部折叠区。
      </p>

      <div className="inner-live-toolbar">
        {piBusy && <span className="inner-live-pulse">Pi-mono 运行中</span>}
        {!brain?.paths.brainDir && (
          <span className="inner-live-warn">尚无 .brain 数据</span>
        )}
      </div>

      <div className="inner-live-core-flow">
        <div className="inner-live-mode-strip">
          <div className={`pi-mode pi-mode-${modeClass}`}>{mode}</div>
          {replanCount > 0 && <span className="inner-live-replan inline">REPLAN ×{replanCount}</span>}
          {blockedReason && <span className="inner-live-block inline">BLOCK：{blockedReason.slice(0, 200)}</span>}
          {sleepUntil && <span className="inner-live-sleep inline">休眠至 {sleepUntil}</span>}
        </div>

        <div className="inner-live-section-title">最近归因</div>
        {lastAttr && (lastAttr.flag !== undefined || lastAttr.reason !== undefined) ? (
          <div className="inner-live-attr inner-live-attr-prominent">
            <div>
              <span className="inner-live-attr-label">flag</span>{' '}
              <code className="inner-live-attr-flag">{String(lastAttr.flag ?? '—')}</code>
            </div>
            <div className="inner-live-attr-reason">
              <span className="inner-live-attr-label">reason</span>
              <pre>{String(lastAttr.reason ?? '（空）')}</pre>
            </div>
            {lastAttr.ts != null && (
              <div className="inner-live-muted inner-live-attr-ts">
                {new Date(String(lastAttr.ts)).toLocaleString()}
              </div>
            )}
          </div>
        ) : (
          <div className="inner-live-muted">跑完 ATTRIBUTE 后出现 attribute.done</div>
        )}

        <div className="inner-live-section-title" style={{ marginTop: 14 }}>
          里程碑
        </div>
        <div className="inner-live-ms inner-live-ms-prominent">
          {ms.length === 0 ? (
            <div className="inner-live-muted">
              {brain?.milestonesText?.trim()
                ? brain.milestonesText.slice(0, 200) + '…'
                : '尚无 milestones.md'}
            </div>
          ) : (
            ms.map((m) => (
              <div key={m.id} className={`inner-live-ms-row ms-${m.status}`}>
                <div className="inner-live-ms-row-head">
                  <span className="inner-live-ms-id">{m.id}</span>
                  <span className="inner-live-ms-title">{m.title}</span>
                </div>
                {m.contract ? (
                  <details className="inner-live-ms-contract">
                    <summary>输入 / 交付约定</summary>
                    <pre>{m.contract}</pre>
                  </details>
                ) : null}
              </div>
            ))
          )}
        </div>

        <div className="inner-live-section-title" style={{ marginTop: 14 }}>
          Goal
        </div>
        <pre className="inner-live-goal inner-live-goal-prominent">
          {brain?.goalText?.trim() ? brain.goalText.slice(0, 1200) : '（空）'}
        </pre>

        <div className="inner-live-section-title" style={{ marginTop: 14 }}>
          当前进度
        </div>
        <div className="inner-live-current-big">{lastHuman}</div>
      </div>

      <details className="inner-live-details inner-live-tech">
        <summary>技术说明与快照（Pi-mono 单步释义、tick 元数据、执行上下文）</summary>
        {explained && (
          <>
            <p className="inner-live-details-summary" style={{ marginTop: 10 }}>
              {explained.summary}
            </p>
            <ul className="inner-live-details-modes">
              {explained.modes.map((row) => (
                <li key={row.mode}>
                  <strong>{row.mode}</strong> — {row.what}
                </li>
              ))}
            </ul>
            <p className="inner-live-details-note">{explained.note}</p>
          </>
        )}
        {lh?.lastControllerTickStart?.data != null && (
          <>
            <div className="inner-live-section-title" style={{ marginTop: 12 }}>
              最近一次 tick
            </div>
            <pre className="inner-live-json-snippet">{JSON.stringify(lh.lastControllerTickStart.data, null, 2)}</pre>
          </>
        )}
        {hasExecCtx && (
          <>
            <div className="inner-live-section-title" style={{ marginTop: 12 }}>
              执行上下文（ATTRIBUTE 前）
            </div>
            <pre className="inner-live-json-snippet inner-live-exctx">{JSON.stringify(exPrev, null, 2)}</pre>
          </>
        )}
      </details>

      <details className="inner-live-details inner-live-logs-fold">
        <summary>
          原始运行日志（Pi-mono JSONL，{entries.length} 条）— 一般无需展开
        </summary>
        <div className="inner-live-log-meta">
          {logs?.source ? <code>{logs.source}</code> : logs?.hint ?? '—'}
        </div>
        <div className="inner-live-entries inner-live-entries-contained">
          {entries.length === 0 ? (
            <div className="inner-live-muted">无日志</div>
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

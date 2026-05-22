import type { GoalJournalEntry, GoalScorecard } from './types.js';
import type { PerformanceGoalEngine } from './engine.js';

function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function badgeColor(value: string): string {
  switch (value) {
    case 'up':
    case 'success':
    case 'active':
      return '#166534';
    case 'down':
    case 'failed':
    case 'archived':
      return '#991b1b';
    case 'paused':
    case 'skipped':
      return '#92400e';
    case 'completed':
      return '#1d4ed8';
    default:
      return '#374151';
  }
}

function renderBadge(label: string): string {
  return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${badgeColor(label)};color:#fff;font-size:12px;line-height:20px;">${escapeHtml(label)}</span>`;
}

function renderScore(scorecard: GoalScorecard | null): string {
  if (!scorecard) return '<span style="color:#6b7280;">尚未审阅</span>';
  return `<strong style="font-size:20px;">${scorecard.currentScore}</strong><span style="color:#6b7280;"> / 100</span>`;
}

function renderJournal(entries: GoalJournalEntry[]): string {
  if (entries.length === 0) {
    return '<div style="color:#6b7280;">暂无日志</div>';
  }
  return `<ul style="margin:0;padding-left:18px;">${entries.slice(0, 3).map((entry) => {
    const summary = entry.entryType === 'action'
      ? `${entry.actionType ?? 'unknown'} / ${entry.actionStatus ?? 'unknown'} / ${entry.actionSummary ?? '无'}`
      : `${entry.suggestedActionType} / ${entry.suggestedActionSummary}`;
    return `<li style="margin:6px 0;"><div style="font-size:12px;color:#6b7280;">${escapeHtml(entry.reviewedAt)}</div><div>${escapeHtml(summary)}</div></li>`;
  }).join('')}</ul>`;
}

export function renderPerformanceDashboard(engine: PerformanceGoalEngine): string {
  const snapshot = engine.getDashboardSnapshot({ includeArchived: true });
  const summaryCards = [
    ['总目标数', String(snapshot.totalGoals)],
    ['活跃目标', String(snapshot.activeGoals)],
    ['需行动建议', String(snapshot.actionableGoals)],
    ['平均分', snapshot.averageScore == null ? 'N/A' : `${snapshot.averageScore}`],
  ];

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Performance Goals Dashboard</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b1220;
      --panel: #111827;
      --panel-2: #172033;
      --text: #e5e7eb;
      --muted: #9ca3af;
      --line: #253047;
      --accent: #60a5fa;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, "Segoe UI", system-ui, sans-serif; background: var(--bg); color: var(--text); }
    .wrap { max-width: 1280px; margin: 0 auto; padding: 24px; }
    .header { display:flex; justify-content:space-between; gap:16px; align-items:flex-end; margin-bottom: 20px; }
    .title { font-size: 28px; font-weight: 700; }
    .sub { color: var(--muted); font-size: 14px; margin-top: 6px; }
    .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-bottom: 20px; }
    .card { background: var(--panel); border:1px solid var(--line); border-radius:16px; padding:16px; box-shadow: 0 4px 20px rgba(0,0,0,.15); }
    .metric-label { color: var(--muted); font-size: 13px; }
    .metric-value { font-size: 28px; font-weight: 700; margin-top: 6px; }
    .meta { display:grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; margin-bottom: 20px; }
    .meta-item { background: var(--panel-2); border-radius: 12px; padding: 12px; border:1px solid var(--line); }
    .meta-item .k { color: var(--muted); font-size: 12px; }
    .meta-item .v { margin-top: 6px; font-weight: 600; }
    .goals { display:grid; gap: 14px; }
    .goal-head { display:flex; justify-content:space-between; align-items:flex-start; gap: 12px; }
    .goal-title { font-size: 18px; font-weight: 700; }
    .goal-id { color: var(--muted); font-size: 12px; margin-top: 4px; }
    .goal-desc { margin-top: 12px; line-height: 1.55; color: #d1d5db; white-space: pre-wrap; }
    .row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-top: 12px; }
    .label { color: var(--muted); font-size: 12px; }
    .pill { background: var(--panel-2); border:1px solid var(--line); border-radius:999px; padding:4px 10px; font-size: 12px; }
    .cols { display:grid; grid-template-columns: 1.4fr 1fr 1fr; gap: 12px; margin-top: 14px; }
    .section { background: rgba(255,255,255,.02); border:1px solid var(--line); border-radius: 12px; padding: 12px; }
    .section h3 { margin:0 0 8px 0; font-size: 13px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .03em; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    @media (max-width: 900px) { .cols { grid-template-columns: 1fr; } .header { flex-direction: column; align-items: flex-start; } }
    a { color: var(--accent); text-decoration: none; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div>
        <div class="title">Performance Goals Dashboard</div>
        <div class="sub">generated at ${escapeHtml(snapshot.generatedAt)} · <a href="/api/performance/goals/dashboard">JSON</a> · <a href="/api/performance/goals">Goals API</a></div>
      </div>
      <div class="sub">zero-build server rendered view</div>
    </div>

    <div class="grid">
      ${summaryCards.map(([label, value]) => `<div class="card"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value">${escapeHtml(value)}</div></div>`).join('')}
    </div>

    <div class="meta">
      ${Object.entries(snapshot.statusCounts).map(([label, value]) => `<div class="meta-item"><div class="k">${escapeHtml(label)}</div><div class="v">${escapeHtml(String(value))}</div></div>`).join('')}
    </div>

    <div class="goals">
      ${snapshot.goals.map(({ goal, scorecard, recentJournal }) => `
        <section class="card">
          <div class="goal-head">
            <div>
              <div class="goal-title">${escapeHtml(goal.title)}</div>
              <div class="goal-id mono">${escapeHtml(goal.id)}</div>
            </div>
            <div class="row">
              ${renderBadge(goal.status)}
              ${scorecard ? renderBadge(scorecard.trend) : ''}
            </div>
          </div>

          <div class="goal-desc">${escapeHtml(goal.goalText)}</div>

          <div class="row">
            <span class="pill">priority ${escapeHtml(String(goal.priority))}</span>
            ${goal.targetSids.map((sid) => `<span class="pill mono">${escapeHtml(sid)}</span>`).join('')}
            ${goal.targetThreadId ? `<span class="pill mono">${escapeHtml(goal.targetThreadId)}</span>` : ''}
          </div>

          <div class="cols">
            <div class="section">
              <h3>Score</h3>
              <div>${renderScore(scorecard)}</div>
              ${scorecard ? `<div style="margin-top:8px;color:#d1d5db;">confidence=${escapeHtml(scorecard.confidence.toFixed(2))}</div>` : ''}
              ${scorecard ? `<div style="margin-top:8px;color:#d1d5db;">${escapeHtml(scorecard.evidenceSummary)}</div>` : ''}
              ${scorecard ? `<div style="margin-top:10px;color:#9ca3af;font-size:12px;">next review: ${escapeHtml(scorecard.nextReviewAt)}</div>` : ''}
            </div>
            <div class="section">
              <h3>Recommendation</h3>
              ${scorecard ? `
                <div>${renderBadge(scorecard.suggestedActionType)}</div>
                <div style="margin-top:8px;">${escapeHtml(scorecard.suggestedActionSummary)}</div>
                ${scorecard.suggestedMessage ? `<div style="margin-top:8px;color:#d1d5db;">msg: ${escapeHtml(scorecard.suggestedMessage)}</div>` : ''}
                ${scorecard.suggestedInnerGoal ? `<div style="margin-top:8px;color:#d1d5db;">goal: ${escapeHtml(scorecard.suggestedInnerGoal)}</div>` : ''}
              ` : '<div style="color:#6b7280;">暂无建议</div>'}
            </div>
            <div class="section">
              <h3>Last Action</h3>
              ${scorecard?.lastActionAt ? `
                <div>${renderBadge(scorecard.lastActionType ?? 'unknown')} ${renderBadge(scorecard.lastActionStatus ?? 'unknown')}</div>
                <div style="margin-top:8px;">${escapeHtml(scorecard.lastActionSummary ?? '无')}</div>
                <div style="margin-top:8px;color:#9ca3af;font-size:12px;">${escapeHtml(scorecard.lastActionAt)}</div>
              ` : '<div style="color:#6b7280;">暂无执行动作</div>'}
            </div>
          </div>

          <div class="section" style="margin-top:14px;">
            <h3>Recent Journal</h3>
            ${renderJournal(recentJournal)}
          </div>
        </section>
      `).join('')}
    </div>
  </div>
</body>
</html>`;
}

/**
 * 两份 RunReport → DELTA
 */
function fmtDelta(a, b, opts = {}) {
  const { invert = false, suffix = '' } = opts;
  if (a == null || b == null) return '-';
  const d = b - a;
  const pct = a !== 0 ? ((d / a) * 100).toFixed(1) : '∞';
  const good = invert ? d < 0 : d > 0;
  const sign = d > 0 ? '+' : '';
  return `${sign}${d}${suffix} (${sign}${pct}%)${good ? ' ✓' : d === 0 ? '' : ' ⚠'}`;
}

function fmtTok(n) {
  if (n == null) return '-';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function compareRuns(baseline, candidate) {
  const deltas = {
    totalTokens: candidate.cost.totalTokens - baseline.cost.totalTokens,
    tokensPerDeliverable:
      (candidate.cost.tokensPerDeliverable ?? 0) - (baseline.cost.tokensPerDeliverable ?? 0),
    burstCount: candidate.execution.burstCount - baseline.execution.burstCount,
    metaBurstRate: candidate.execution.metaBurstRate - baseline.execution.metaBurstRate,
    totalDeliverables: candidate.execution.totalDeliverables - baseline.execution.totalDeliverables,
    executorRoundP95: candidate.execution.executorRoundP95 - baseline.execution.executorRoundP95,
  };

  return {
    schemaVersion: 1,
    comparedAt: new Date().toISOString(),
    baseline: { runId: baseline.runId, label: baseline.label, runKind: baseline.runKind },
    candidate: { runId: candidate.runId, label: candidate.label, runKind: candidate.runKind },
    deltas,
  };
}

export function renderDeltaMarkdown(baseline, candidate, comparison) {
  const lines = [];
  lines.push('# Run 对比（调优 delta）');
  lines.push('');
  lines.push(`| | Baseline | Candidate |`);
  lines.push(`|--|----------|-----------|`);
  lines.push(`| runId | ${baseline.runId} | ${candidate.runId} |`);
  lines.push(`| label | ${baseline.label || '-'} | ${candidate.label || '-'} |`);
  lines.push('');

  lines.push('## 成本（candidate − baseline，下降为 ✓）');
  lines.push('');
  lines.push(`| 指标 | baseline | candidate | delta |`);
  lines.push(`|------|----------|-----------|-------|`);
  lines.push(
    `| totalTokens | ${fmtTok(baseline.cost.totalTokens)} | ${fmtTok(candidate.cost.totalTokens)} | ${fmtDelta(baseline.cost.totalTokens, candidate.cost.totalTokens, { invert: true })} |`,
  );
  lines.push(
    `| tokensPerDeliverable | ${fmtTok(baseline.cost.tokensPerDeliverable)} | ${fmtTok(candidate.cost.tokensPerDeliverable)} | ${fmtDelta(baseline.cost.tokensPerDeliverable, candidate.cost.tokensPerDeliverable, { invert: true })} |`,
  );
  lines.push(
    `| llmCalls | ${baseline.cost.llmCalls} | ${candidate.cost.llmCalls} | ${fmtDelta(baseline.cost.llmCalls, candidate.cost.llmCalls, { invert: true })} |`,
  );
  lines.push('');

  lines.push('## 执行结构');
  lines.push('');
  lines.push(`| 指标 | baseline | candidate | delta |`);
  lines.push(`|------|----------|-----------|-------|`);
  lines.push(
    `| burstCount | ${baseline.execution.burstCount} | ${candidate.execution.burstCount} | ${fmtDelta(baseline.execution.burstCount, candidate.execution.burstCount, { invert: true })} |`,
  );
  lines.push(
    `| metaBurstRate | ${(baseline.execution.metaBurstRate * 100).toFixed(1)}% | ${(candidate.execution.metaBurstRate * 100).toFixed(1)}% | ${fmtDelta(baseline.execution.metaBurstRate, candidate.execution.metaBurstRate, { invert: true })} |`,
  );
  lines.push(
    `| totalDeliverables | ${baseline.execution.totalDeliverables} | ${candidate.execution.totalDeliverables} | ${fmtDelta(baseline.execution.totalDeliverables, candidate.execution.totalDeliverables)} |`,
  );
  lines.push(
    `| executorRoundP95 | ${baseline.execution.executorRoundP95} | ${candidate.execution.executorRoundP95} | ${fmtDelta(baseline.execution.executorRoundP95, candidate.execution.executorRoundP95, { invert: true })} |`,
  );
  lines.push('');

  if (baseline.runKind === 'pokemon') {
    lines.push('## Outcome pokemon');
    lines.push('');
    const bk = ['battleLogExists', 'ratedOuAttempt', 'battleOutcomeLogged', 'screenshotArtifacts'];
    for (const k of bk) {
      const a = baseline.outcome?.[k] ?? 0;
      const b = candidate.outcome?.[k] ?? 0;
      lines.push(`- ${k}: ${a} → ${b} (${b >= a ? '≥ baseline' : '⚠ 低于 baseline'})`);
    }
    lines.push('');
  }

  if (baseline.runKind === 'novel') {
    lines.push('## Outcome novel');
    lines.push('');
    lines.push(
      `- chapterFiles: ${baseline.outcome?.chapterFiles ?? 0} → ${candidate.outcome?.chapterFiles ?? 0}`,
    );
    lines.push(
      `- totalWords: ${baseline.outcome?.totalWords ?? 0} → ${candidate.outcome?.totalWords ?? 0}`,
    );
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(comparison.deltas, null, 2));
  lines.push('```');

  return lines.join('\n');
}

/**
 * RunReport → RUN-SUMMARY.md
 */
function fmtTok(n) {
  if (n == null || Number.isNaN(n)) return '-';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function pct(n) {
  if (n == null || Number.isNaN(n)) return '-';
  return `${(n * 100).toFixed(1)}%`;
}

export function renderRunSummary(report) {
  const lines = [];
  lines.push(`# Run 分析报告：${report.label || report.runId}`);
  lines.push('');
  lines.push(`- **runId**: ${report.runId}`);
  lines.push(`- **runKind**: ${report.runKind}`);
  lines.push(`- **分析时间**: ${report.analyzedAt}`);
  lines.push(`- **DATA_ROOT**: \`${report.dataRoot}\``);
  lines.push(`- **时间窗**: ${report.window.from ?? '（全量 usage）'} → ${report.window.to ?? '（全量）'}`);
  if (report.gitSha) lines.push(`- **git**: ${report.gitSha}`);
  lines.push('');

  lines.push('## 成本');
  lines.push('');
  lines.push(`| 指标 | 值 |`);
  lines.push(`|------|-----|`);
  lines.push(`| totalTokens | ${fmtTok(report.cost.totalTokens)} |`);
  lines.push(`| prompt / completion | ${fmtTok(report.cost.promptTokens)} / ${fmtTok(report.cost.completionTokens)} |`);
  lines.push(`| llmCalls | ${report.cost.llmCalls} |`);
  lines.push(`| prompt:completion 比 | ${report.cost.promptToCompletionRatio?.toFixed(1) ?? '-'} |`);
  lines.push(`| tokensPerDeliverable | ${report.cost.tokensPerDeliverable != null ? fmtTok(report.cost.tokensPerDeliverable) : '-'} |`);
  lines.push(`| tokens/小时 | ${report.cost.costPerHour != null ? fmtTok(report.cost.costPerHour) : '-'} |`);
  lines.push('');

  lines.push('### 按来源');
  lines.push('');
  for (const [src, b] of Object.entries(report.cost.bySource ?? {}).sort(
    (a, b) => b[1].totalTokens - a[1].totalTokens,
  )) {
    lines.push(`- **${src}**: ${fmtTok(b.totalTokens)} (${b.calls} calls)`);
  }
  lines.push('');

  lines.push('### Token Top 实例');
  lines.push('');
  for (const row of report.cost.topInstances ?? []) {
    lines.push(`- \`${row.instanceId}\`: ${fmtTok(row.totalTokens)} (${row.calls} calls)`);
  }
  lines.push('');

  lines.push('## 执行结构');
  lines.push('');
  lines.push(`| 指标 | 值 |`);
  lines.push(`|------|-----|`);
  lines.push(`| burstCount | ${report.execution.burstCount} |`);
  lines.push(`| metaBurstRate | ${pct(report.execution.metaBurstRate)} (${report.execution.metaBurstCount}) |`);
  lines.push(`| totalDeliverables | ${report.execution.totalDeliverables} |`);
  lines.push(`| avgTicksPerBurst | ${report.execution.avgTicksPerBurst?.toFixed(1) ?? '-'} |`);
  lines.push(`| parallelRunningMax | ${report.execution.parallelRunningMax} |`);
  lines.push(`| executorRoundP95 | ${report.execution.executorRoundP95} |`);
  lines.push('');

  lines.push('### burst 状态');
  lines.push('');
  for (const [st, n] of Object.entries(report.execution.burstByStatus ?? {})) {
    lines.push(`- ${st}: ${n}`);
  }
  lines.push('');

  lines.push('### 工具 mix（Top）');
  lines.push('');
  const tools = Object.entries(report.execution.toolMix ?? {})
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10);
  for (const [name, v] of tools) {
    lines.push(`- ${name}: ${v.count} (${pct(v.share)})`);
  }
  lines.push('');

  if ((report.execution.topRepeatedReads ?? []).length > 0) {
    lines.push('### 重复 read（Top）');
    lines.push('');
    for (const r of report.execution.topRepeatedReads) {
      lines.push(`- ${r.count}× \`${r.path.slice(0, 100)}\``);
    }
    lines.push('');
  }

  lines.push('## 战略 / 调度');
  lines.push('');
  lines.push(`- reflexion 增量: ${report.strategy.reflexionCount}`);
  lines.push(`- KPI abandoned 切换: ${report.strategy.kpiSwitchCount}`);
  lines.push(`- autonomy skip: ${report.strategy.idleDispatchSkips} / events ${report.strategy.autonomyEvents}`);
  lines.push('');

  if (report.runKind === 'pokemon' && report.outcome) {
    lines.push('## Outcome（pokemon）');
    lines.push('');
    const o = report.outcome;
    lines.push(`- battleLogExists: ${o.battleLogExists}`);
    lines.push(`- ratedOuAttempt: ${o.ratedOuAttempt}`);
    lines.push(`- battleOutcomeLogged: ${o.battleOutcomeLogged}`);
    lines.push(`- screenshotArtifacts: ${o.screenshotArtifacts}`);
    lines.push('');
  }

  if (report.runKind === 'novel' && report.outcome) {
    lines.push('## Outcome（novel）');
    lines.push('');
    lines.push(`- chapterFiles: ${report.outcome.chapterFiles}`);
    lines.push(`- totalWords: ${report.outcome.totalWords}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * 真实 DATA_ROOT → RunReport（纯数据分析，不启动 agent）。
 */
import fs from 'node:fs';
import path from 'node:path';

const META_GOAL_RE = /诊断|分析.*\bib-|检查.*\bib-|ib-[a-z0-9]+-[a-f0-9]{4}.*状态/i;
const BATTLE_LOG_NAMES = ['battle_run.log', 'rated_battle_output.log', 'm3_stdout.log'];
const OUTCOME_WIN_LOSS_RE = /\b(WIN|LOSS|victory|defeat|winner)\b/i;

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function inWindow(iso, fromMs, toMs) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  if (fromMs != null && t < fromMs) return false;
  if (toMs != null && t > toMs) return false;
  return true;
}

function emptyBucket() {
  return { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function addBucket(bucket, entry) {
  bucket.calls += 1;
  bucket.promptTokens += entry.promptTokens ?? 0;
  bucket.completionTokens += entry.completionTokens ?? 0;
  bucket.totalTokens += entry.totalTokens ?? 0;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

function scanPiMonoLogs(workspacesRoot, instanceIds) {
  const toolCounts = {};
  const readTargets = {};
  const executorRoundsByInst = {};
  let logLines = 0;

  for (const instId of instanceIds) {
    const wsName = instId.startsWith('task-') ? instId : `task-${instId}`;
    const logsDir = path.join(workspacesRoot, wsName, '.run', 'pi-mono', 'logs');
    if (!fs.existsSync(logsDir)) continue;

    for (const name of fs.readdirSync(logsDir)) {
      if (!name.endsWith('.jsonl')) continue;
      const fp = path.join(logsDir, name);
      let maxRound = -1;
      for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        logLines++;
        let j;
        try {
          j = JSON.parse(line);
        } catch {
          continue;
        }
        if (j.module === 'executor' && j.event === 'tool.call') {
          const tool = j.data?.name ?? '?';
          toolCounts[tool] = (toolCounts[tool] || 0) + 1;
          if (tool === 'read_file' || tool === 'read_peer_file') {
            const target =
              j.data?.args?.path ?? j.data?.args?.file ?? JSON.stringify(j.data?.args ?? '').slice(0, 80);
            const key = String(target).replace(/\\/g, '/');
            readTargets[key] = (readTargets[key] || 0) + 1;
          }
        }
        if (j.module === 'executor' && j.event === 'llm.call') {
          const r = typeof j.data?.round === 'number' ? j.data.round : -1;
          if (r > maxRound) maxRound = r;
        }
      }
      if (maxRound >= 0) executorRoundsByInst[instId] = maxRound;
    }
  }

  const executorRounds = Object.values(executorRoundsByInst);
  executorRounds.sort((a, b) => a - b);

  const topRepeatedReads = Object.entries(readTargets)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([pathKey, count]) => ({ path: pathKey, count }));

  const toolTotal = Object.values(toolCounts).reduce((a, b) => a + b, 0);
  const toolMix = {};
  for (const [k, v] of Object.entries(toolCounts)) {
    toolMix[k] = { count: v, share: toolTotal > 0 ? v / toolTotal : 0 };
  }

  return {
    logLines,
    toolMix,
    topRepeatedReads,
    executorRoundP95: percentile(executorRounds, 95),
    executorRoundMax: executorRounds.length ? executorRounds[executorRounds.length - 1] : 0,
  };
}

function estimateParallelRunningMax(bursts) {
  const events = [];
  for (const b of bursts) {
    const start = new Date(b.startedAt).getTime();
    if (Number.isNaN(start)) continue;
    events.push({ t: start, delta: 1 });
    const endIso = b.finishedAt ?? b.startedAt;
    const end = new Date(endIso).getTime();
    if (!Number.isNaN(end) && end >= start) {
      events.push({ t: end + 1, delta: -1 });
    }
  }
  events.sort((a, b) => a.t - b.t || a.delta - b.delta);
  let cur = 0;
  let max = 0;
  for (const e of events) {
    cur += e.delta;
    if (cur > max) max = cur;
  }
  return max;
}

function scanPokemonOutcome(workspacesRoot, instanceIds) {
  let battleLogExists = 0;
  let ratedOuAttempt = 0;
  let battleOutcomeLogged = 0;
  let screenshotArtifacts = 0;

  for (const instId of instanceIds) {
    const wsName = instId.startsWith('task-') ? instId : `task-${instId}`;
    const wsDir = path.join(workspacesRoot, wsName);
    if (!fs.existsSync(wsDir)) continue;

    for (const logName of BATTLE_LOG_NAMES) {
      const fp = path.join(wsDir, logName);
      if (!fs.existsSync(fp)) continue;
      battleLogExists += 1;
      const text = fs.readFileSync(fp, 'utf8');
      if (text.includes('/search gen9ou') || text.includes('gen9ou')) ratedOuAttempt += 1;
      if (OUTCOME_WIN_LOSS_RE.test(text)) battleOutcomeLogged += 1;
    }

    function walkPng(dir) {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory() && !ent.name.startsWith('.')) walkPng(p);
        else if (/\.png$/i.test(ent.name) && /battle/i.test(ent.name)) screenshotArtifacts += 1;
      }
    }
    try {
      walkPng(wsDir);
    } catch {
      /* ignore */
    }
  }

  return { battleLogExists, ratedOuAttempt, battleOutcomeLogged, screenshotArtifacts };
}

function scanNovelOutcome(workspacesRoot, instanceIds) {
  let chapterFiles = 0;
  let totalWords = 0;
  const chapterPattern = /chapter|第[0-9一二三四五六七八九十百千]+章|卷|episode/i;

  for (const instId of instanceIds) {
    const wsName = instId.startsWith('task-') ? instId : `task-${instId}`;
    const wsDir = path.join(workspacesRoot, wsName);
    if (!fs.existsSync(wsDir)) continue;

    function walkMd(dir) {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory() && !ent.name.startsWith('.run')) walkMd(p);
        else if (ent.name.endsWith('.md') && chapterPattern.test(ent.name)) {
          chapterFiles += 1;
          try {
            const text = fs.readFileSync(p, 'utf8');
            totalWords += text.split(/\s+/).filter(Boolean).length;
          } catch {
            /* ignore */
          }
        }
      }
    }
    try {
      walkMd(wsDir);
    } catch {
      /* ignore */
    }
  }

  return { chapterFiles, totalWords };
}

function topInstancesByTokens(usageRows, limit = 12) {
  const byInst = {};
  for (const row of usageRows) {
    const id = row.instanceId ?? '(no-instance)';
    if (!byInst[id]) byInst[id] = emptyBucket();
    addBucket(byInst[id], row);
  }
  return Object.entries(byInst)
    .sort((a, b) => b[1].totalTokens - a[1].totalTokens)
    .slice(0, limit)
    .map(([instanceId, bucket]) => ({ instanceId, ...bucket }));
}

export function analyzeRun(opts) {
  const dataRoot = path.resolve(opts.dataRoot);
  const fromMs = opts.from ? new Date(opts.from).getTime() : null;
  const toMs = opts.to ? new Date(opts.to).getTime() : null;
  const runKind = opts.runKind ?? 'other';

  const usageAll = readJsonl(path.join(dataRoot, 'usage', 'llm-usage.jsonl'));
  const usageRows = usageAll.filter((r) => inWindow(r.at, fromMs, toMs));

  let registry = [];
  const regPath = path.join(dataRoot, 'inner-brain-registry.json');
  if (fs.existsSync(regPath)) {
    registry = JSON.parse(fs.readFileSync(regPath, 'utf8'));
  }

  const bursts = registry.filter((r) => inWindow(r.startedAt, fromMs, toMs));
  const instanceIds = bursts.map((b) => b.instanceId);

  const totals = emptyBucket();
  const bySource = {};
  const byModel = {};
  for (const row of usageRows) {
    addBucket(totals, row);
    const src = row.source ?? 'unknown';
    if (!bySource[src]) bySource[src] = emptyBucket();
    addBucket(bySource[src], row);
    const model = row.model ?? 'unknown';
    if (!byModel[model]) byModel[model] = emptyBucket();
    addBucket(byModel[model], row);
  }

  const burstByStatus = {};
  let totalDeliverables = 0;
  let totalTicks = 0;
  let metaBursts = 0;
  for (const b of bursts) {
    burstByStatus[b.status] = (burstByStatus[b.status] ?? 0) + 1;
    totalDeliverables += b.deliverableCount ?? 0;
    totalTicks += b.ticks ?? 0;
    if (META_GOAL_RE.test(b.goal ?? '')) metaBursts += 1;
  }

  const workspacesRoot = path.join(dataRoot, 'workspaces');
  const pi = scanPiMonoLogs(workspacesRoot, instanceIds);

  const autonomyRows = readJsonl(path.join(dataRoot, 'autonomy', 'action-log.jsonl')).filter((r) =>
    inWindow(r.at, fromMs, toMs),
  );
  const idleDispatchSkips = autonomyRows.filter(
    (r) => r.dispatched === false && typeof r.reason === 'string',
  ).length;

  let kpiSwitchCount = 0;
  let reflexionCount = 0;
  const kpiPath = path.join(dataRoot, 'kpi-registry.json');
  if (fs.existsSync(kpiPath)) {
    const kpis = JSON.parse(fs.readFileSync(kpiPath, 'utf8'));
    for (const k of kpis) {
      if (k.status === 'abandoned' && inWindow(k.finalizedAt, fromMs, toMs)) kpiSwitchCount += 1;
      if (Array.isArray(k.reflexionTrail)) {
        reflexionCount += k.reflexionTrail.filter((r) => inWindow(r.ts, fromMs, toMs)).length;
      }
    }
  }

  const wallMs = fromMs != null && toMs != null && toMs > fromMs ? toMs - fromMs : null;
  const wallHours = wallMs != null ? wallMs / 3_600_000 : null;

  const outcome =
    runKind === 'pokemon'
      ? scanPokemonOutcome(workspacesRoot, instanceIds)
      : runKind === 'novel'
        ? scanNovelOutcome(workspacesRoot, instanceIds)
        : {};

  return {
    schemaVersion: 1,
    runId: opts.runId ?? 'unnamed',
    runKind,
    label: opts.label ?? '',
    analyzedAt: new Date().toISOString(),
    dataRoot,
    window: { from: opts.from ?? null, to: opts.to ?? null },
    gitSha: opts.gitSha ?? null,

    cost: {
      totalTokens: totals.totalTokens,
      promptTokens: totals.promptTokens,
      completionTokens: totals.completionTokens,
      llmCalls: totals.calls,
      promptToCompletionRatio:
        totals.completionTokens > 0 ? totals.promptTokens / totals.completionTokens : null,
      tokensPerDeliverable: totalDeliverables > 0 ? totals.totalTokens / totalDeliverables : null,
      costPerHour: wallHours && wallHours > 0 ? totals.totalTokens / wallHours : null,
      bySource,
      byModel,
      topInstances: topInstancesByTokens(usageRows),
    },

    execution: {
      burstCount: bursts.length,
      burstByStatus,
      metaBurstCount: metaBursts,
      metaBurstRate: bursts.length > 0 ? metaBursts / bursts.length : 0,
      avgTicksPerBurst: bursts.length > 0 ? totalTicks / bursts.length : 0,
      totalDeliverables,
      parallelRunningMax: estimateParallelRunningMax(bursts),
      toolMix: pi.toolMix,
      topRepeatedReads: pi.topRepeatedReads,
      executorRoundP95: pi.executorRoundP95,
      executorRoundMax: pi.executorRoundMax,
      piMonoLogLines: pi.logLines,
    },

    strategy: {
      reflexionCount,
      kpiSwitchCount,
      idleDispatchSkips,
      autonomyEvents: autonomyRows.length,
    },

    outcome,

    bursts: bursts.map((b) => ({
      instanceId: b.instanceId,
      status: b.status,
      startedAt: b.startedAt,
      finishedAt: b.finishedAt ?? null,
      ticks: b.ticks ?? null,
      deliverableCount: b.deliverableCount ?? 0,
      kpiId: b.kpiId ?? null,
      isMeta: META_GOAL_RE.test(b.goal ?? ''),
      goalPreview: (b.goal ?? '').slice(0, 120).replace(/\s+/g, ' '),
    })),
  };
}

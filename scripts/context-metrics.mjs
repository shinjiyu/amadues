#!/usr/bin/env node
/**
 * 离线分析：历史知识使用 / 重复读 / 跨里程碑工具重叠（无需重跑任务）。
 *
 * 用法：
 *   node scripts/context-metrics.mjs
 *   node scripts/context-metrics.mjs --jsonl path/to/day.jsonl --workspace path/to/workspace/root
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dir, '..');

function parseArgs() {
  const a = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--jsonl') out.jsonl = a[++i];
    if (a[i] === '--workspace') out.workspace = a[++i];
  }
  return out;
}

const defaults = {
  jsonl: path.join(
    repoRoot,
    'packages/server/data/workspaces/default/.run/pi-mono/logs',
    `${new Date().toISOString().slice(0, 10)}.jsonl`,
  ),
  workspace: path.join(repoRoot, 'packages/server/data/workspaces/default'),
};

function loadEvents(jsonlPath) {
  if (!fs.existsSync(jsonlPath)) {
    console.error('找不到日志:', jsonlPath);
    process.exit(1);
  }
  const raw = fs.readFileSync(jsonlPath, 'utf8');
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function normPath(p, workspaceRoot) {
  if (!p || typeof p !== 'string') return null;
  let x = p.replace(/\\/g, '/').trim();
  if (workspaceRoot && path.isAbsolute(x)) {
    const rel = path.relative(workspaceRoot, x);
    if (!rel.startsWith('..')) x = rel.replace(/\\/g, '/');
  }
  return x.replace(/\/{2,}/g, '/');
}

/** 从 shell_exec 里抠可读路径（启发式） */
function pathsFromShell(command) {
  if (typeof command !== 'string') return [];
  const out = [];
  const re =
    /\b(?:cat|head|tail|sed|wc|grep)\s+[^\s&|;]*['"]?([^\s'"&|;]+\.(?:ts|tsx|js|mjs|json|md|txt))['"]?/gi;
  let m;
  while ((m = re.exec(command)) !== null) {
    out.push(m[1]);
  }
  const abs = command.match(/\/Users\/[^\s'"&|;]+|\/home\/[^\s'"&|;]+/gi);
  if (abs) out.push(...abs);
  return [...new Set(out)];
}

function toolReadTargets(e, workspaceRoot) {
  if (e.module !== 'executor' || e.event !== 'tool.call') return [];
  const name = e.data?.name;
  const args = e.data?.args ?? {};
  const targets = [];
  if (name === 'read_file' && args.path) {
    const n = normPath(args.path, workspaceRoot);
    if (n) targets.push(n);
  }
  if (name === 'shell_exec' && args.command) {
    for (const p of pathsFromShell(args.command)) {
      const n = normPath(p, workspaceRoot);
      if (n) targets.push(n);
    }
  }
  return targets;
}

function loadKnowledgeCorpus(workspaceRoot) {
  const files = ['.brain/knowledge.md', 'architecture-analysis.md', 'code-structure-overview.md'];
  const chunks = [];
  for (const rel of files) {
    const fp = path.join(workspaceRoot, rel);
    if (fs.existsSync(fp)) {
      chunks.push(fs.readFileSync(fp, 'utf8'));
    }
  }
  return chunks.join('\n');
}

/** 若读的路径在知识库文本里出现过子串，视为「知识里已有线索仍去读」的弱信号 */
function appearsInCorpus(target, corpus) {
  if (!target || target.length < 4) return false;
  const tail = target.split('/').pop() ?? target;
  if (tail.length < 4) return false;
  return corpus.includes(target) || corpus.includes(tail);
}

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const uni = A.size + B.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

function analyze(events, workspaceRoot) {
  const corpus = loadKnowledgeCorpus(workspaceRoot);

  /** 按 execute.start → execute.done 切段，带 milestoneId */
  const segments = [];
  let open = null;
  for (const e of events) {
    if (e.module === 'executor' && e.event === 'execute.start') {
      open = { id: e.data?.milestoneId ?? '?', title: e.data?.title, start: e.ts, targets: [] };
    } else if (open && e.module === 'executor' && e.event === 'execute.done') {
      if (e.data?.milestoneId === open.id) {
        open.end = e.ts;
        open.toolCalls = e.data?.toolCalls;
        segments.push(open);
        open = null;
      }
    } else if (open && e.module === 'executor') {
      open.targets.push(...toolReadTargets(e, workspaceRoot));
    }
  }

  const byMilestone = {};
  for (const s of segments) {
    if (!byMilestone[s.id]) byMilestone[s.id] = [];
    byMilestone[s.id].push(s);
  }

  const perSegment = segments.map((s) => {
    const counts = {};
    for (const t of s.targets) counts[t] = (counts[t] || 0) + 1;
    const redundant = Object.entries(counts).filter(([, c]) => c > 1);
    const redundantHits = redundant.reduce((a, [, c]) => a + (c - 1), 0);
    const totalReads = s.targets.length;
    let bypass = 0;
    for (const t of s.targets) {
      if (appearsInCorpus(t, corpus)) bypass++;
    }
    const ms = Date.parse(s.end) - Date.parse(s.start);
    const writes =
      events.filter(
        (e) =>
          e.module === 'executor' &&
          e.event === 'tool.call' &&
          e.data?.name === 'write_file' &&
          Date.parse(e.ts) >= Date.parse(s.start) &&
          Date.parse(e.ts) <= Date.parse(s.end),
      ).length;
    return {
      milestoneId: s.id,
      title: s.title,
      start: s.start,
      end: s.end,
      wallMs: ms,
      toolCallsReported: s.toolCalls,
      readLikeTargets: totalReads,
      redundantPathKinds: redundant.length,
      redundantExtraReads: redundantHits,
      redundantRate: totalReads ? redundantHits / totalReads : 0,
      knowledgeCorpusHitReads: bypass,
      knowledgeHitRate: totalReads ? bypass / totalReads : 0,
      writeFileCalls: writes,
      readWriteRatio: writes ? totalReads / writes : totalReads,
    };
  });

  /** 跨段 Jaccard：相邻同 milestone 的连续 EXECUTE 轮次 */
  const adjJaccard = [];
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].id !== segments[i - 1].id) continue;
    const j = jaccard(segments[i - 1].targets, segments[i].targets);
    adjJaccard.push({
      milestoneId: segments[i].id,
      pass: `${i} vs ${i + 1}`,
      jaccard: Number(j.toFixed(3)),
    });
  }

  /** 按 milestone 聚合路径集合，算与上一 milestone 的 Jaccard */
  const milestoneOrder = [...new Set(segments.map((s) => s.id))];
  const unionByMs = {};
  for (const s of segments) {
    if (!unionByMs[s.id]) unionByMs[s.id] = new Set();
    for (const t of s.targets) unionByMs[s.id].add(t);
  }
  const crossJ = [];
  for (let i = 1; i < milestoneOrder.length; i++) {
    const a = milestoneOrder[i - 1];
    const b = milestoneOrder[i];
    crossJ.push({
      from: a,
      to: b,
      jaccard: Number(jaccard([...unionByMs[a]], [...unionByMs[b]]).toFixed(3)),
    });
  }

  /** M4：首 write_file 相对第一次 M4 execute.start 的延迟 */
  let m4FirstStart = null;
  let m4FirstWrite = null;
  for (const e of events) {
    if (e.module === 'executor' && e.event === 'execute.start' && e.data?.milestoneId === 'M4') {
      if (!m4FirstStart) m4FirstStart = e.ts;
    }
    if (
      m4FirstStart &&
      e.module === 'executor' &&
      e.event === 'tool.call' &&
      e.data?.name === 'write_file' &&
      e.data?.args?.path?.includes('code-structure')
    ) {
      m4FirstWrite = e.ts;
      break;
    }
  }
  const m4WriteLatencyMs =
    m4FirstStart && m4FirstWrite ? Date.parse(m4FirstWrite) - Date.parse(m4FirstStart) : null;

  return {
    meta: {
      jsonl: 'see argv',
      workspace: workspaceRoot,
      corpusFilesPresent: ['.brain/knowledge.md', 'architecture-analysis.md'].filter((f) =>
        fs.existsSync(path.join(workspaceRoot, f)),
      ),
    },
    segmentCount: segments.length,
    perSegment,
    sameMilestoneAdjacentJaccard: adjJaccard,
    crossMilestoneJaccard: crossJ,
    m4: {
      firstExecuteStart: m4FirstStart,
      firstCodeStructureWrite: m4FirstWrite,
      writeLatencyMs: m4WriteLatencyMs,
      writeLatencyHuman:
        m4WriteLatencyMs == null
          ? null
          : `${Math.round(m4WriteLatencyMs / 60000)}m${Math.round((m4WriteLatencyMs % 60000) / 1000)}s`,
    },
  };
}

const args = parseArgs();
const jsonl = args.jsonl && fs.existsSync(args.jsonl) ? args.jsonl : defaults.jsonl;
const workspace = args.workspace && fs.existsSync(args.workspace) ? args.workspace : defaults.workspace;

if (!fs.existsSync(jsonl)) {
  console.error('未找到默认当日日志，请指定: --jsonl <path>');
  console.error('尝试路径:', jsonl);
  process.exit(1);
}

const events = loadEvents(jsonl);
const result = analyze(events, workspace);
result.meta.jsonl = jsonl;
result.meta.eventCount = events.length;

console.log(JSON.stringify(result, null, 2));

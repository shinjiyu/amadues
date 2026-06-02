#!/usr/bin/env node
/**
 * 对比两份 RunReport（baseline vs candidate）→ DELTA.md
 */
import fs from 'node:fs';
import path from 'node:path';

import { compareRuns, renderDeltaMarkdown } from './lib/compare-runs.mjs';
import { resolveObservationsRoot, resolveRunOutputDir } from './lib/paths.mjs';

function loadReport(p) {
  const abs = path.resolve(p);
  if (fs.statSync(abs).isDirectory()) {
    return JSON.parse(fs.readFileSync(path.join(abs, 'RunReport.json'), 'utf8'));
  }
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

function parseArgs(argv) {
  const out = { baseline: null, candidate: null, out: null, obsRoot: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--baseline' && next) {
      out.baseline = next;
      i++;
    } else if (a === '--candidate' && next) {
      out.candidate = next;
      i++;
    } else if (a === '--out' && next) {
      out.out = next;
      i++;
    } else if (a === '--obs-root' && next) {
      out.obsRoot = next;
      i++;
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    }
  }
  return out;
}

function printHelp() {
  console.log(`compare-runs — 对比两次 Run 分析

  node scripts/observe/compare-runs.mjs \\
    --baseline  <RunReport.json 或 run 目录> \\
    --candidate <RunReport.json 或 run 目录> \\
    [--out <DELTA.md 路径>]

默认输出到 candidate 目录旁: compare-<baseline-runId>-vs-<candidate-runId>/DELTA.md
`);
}

const args = parseArgs(process.argv);
if (args.help || !args.baseline || !args.candidate) {
  printHelp();
  process.exit(args.baseline && args.candidate ? 0 : 1);
}

const baseline = loadReport(args.baseline);
const candidate = loadReport(args.candidate);
const comparison = compareRuns(baseline, candidate);
const md = renderDeltaMarkdown(baseline, candidate, comparison);

const obsRoot = resolveObservationsRoot(args.obsRoot);
const compareId = `compare-${baseline.runId}-vs-${candidate.runId}`.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180);
const outDir = args.out
  ? path.dirname(path.resolve(args.out))
  : path.join(obsRoot, 'comparisons', compareId);

fs.mkdirSync(outDir, { recursive: true });
const deltaPath = args.out ?? path.join(outDir, 'DELTA.md');
const jsonPath = path.join(outDir, 'DELTA.json');

fs.writeFileSync(deltaPath, md + '\n', 'utf8');
fs.writeFileSync(jsonPath, JSON.stringify(comparison, null, 2) + '\n', 'utf8');

console.log(`DELTA → ${deltaPath}`);

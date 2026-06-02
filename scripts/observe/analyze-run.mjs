#!/usr/bin/env node
/**
 * 分析真实 DATA_ROOT 时间窗 → RunReport，落盘到仓库外 observations 目录。
 *
 * 用法见 scripts/observe/README.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

import { analyzeRun } from './lib/analyze-run.mjs';
import { renderRunSummary } from './lib/render-summary.mjs';
import {
  makeRunId,
  resolveObservationsRoot,
  resolveRunOutputDir,
} from './lib/paths.mjs';

function parseArgs(argv) {
  const out = {
    dataRoot: null,
    from: null,
    to: null,
    kind: 'other',
    label: '',
    runId: null,
    obsRoot: null,
    gitSha: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--data-root' && next) {
      out.dataRoot = next;
      i++;
    } else if (a === '--from' && next) {
      out.from = next;
      i++;
    } else if (a === '--to' && next) {
      out.to = next;
      i++;
    } else if (a === '--kind' && next) {
      out.kind = next;
      i++;
    } else if (a === '--label' && next) {
      out.label = next;
      i++;
    } else if (a === '--run-id' && next) {
      out.runId = next;
      i++;
    } else if (a === '--obs-root' && next) {
      out.obsRoot = next;
      i++;
    } else if (a === '--git-sha' && next) {
      out.gitSha = next;
      i++;
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    }
  }
  return out;
}

function tryGitSha() {
  try {
    return execSync('hutao rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    try {
      return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  }
}

function printHelp() {
  console.log(`analyze-run — 真实 agent DATA_ROOT 数据分析

必选:
  --data-root <path>     agent DATA_ROOT（如 packages/server/data-yuanbao）

可选:
  --from <ISO>           时间窗起点（按 burst.startedAt / usage.at 过滤）
  --to <ISO>             时间窗终点
  --kind pokemon|novel|other
  --label <text>         人类标签（如 baseline-v0）
  --run-id <id>          输出目录名（默认自动生成）
  --obs-root <path>      观测落盘根（默认 ../kuroneko-observations 或 KURONEKO_OBSERVATIONS_DIR）
  --git-sha <sha>        记录分支 commit

输出（不在 git 仓库内）:
  <obs-root>/runs/<kind>/<run-id>/
    run-meta.json
    RunReport.json
    RUN-SUMMARY.md
`);
}

const args = parseArgs(process.argv);
if (args.help || !args.dataRoot) {
  printHelp();
  process.exit(args.dataRoot ? 0 : 1);
}

const runId = args.runId ?? makeRunId(args.label || args.kind);
const gitSha = args.gitSha ?? tryGitSha();

const report = analyzeRun({
  dataRoot: args.dataRoot,
  from: args.from,
  to: args.to,
  runKind: args.kind,
  label: args.label,
  runId,
  gitSha,
});

const obsRoot = resolveObservationsRoot(args.obsRoot);
const outDir = resolveRunOutputDir(obsRoot, args.kind, runId);
fs.mkdirSync(outDir, { recursive: true });

const runMeta = {
  runId,
  runKind: args.kind,
  label: args.label,
  dataRoot: path.resolve(args.dataRoot),
  window: { from: args.from, to: args.to },
  gitSha,
  writtenAt: new Date().toISOString(),
  outputDir: outDir,
};

fs.writeFileSync(path.join(outDir, 'run-meta.json'), JSON.stringify(runMeta, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(outDir, 'RunReport.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(outDir, 'RUN-SUMMARY.md'), renderRunSummary(report) + '\n', 'utf8');

// 索引：便于 compare 时浏览
const indexPath = path.join(obsRoot, 'index.jsonl');
fs.appendFileSync(
  indexPath,
  JSON.stringify({
    runId,
    runKind: args.kind,
    label: args.label,
    gitSha,
    totalTokens: report.cost.totalTokens,
    burstCount: report.execution.burstCount,
    outDir,
    at: runMeta.writtenAt,
  }) + '\n',
  'utf8',
);

console.log(`RunReport → ${outDir}`);
console.log(`  totalTokens=${report.cost.totalTokens}  bursts=${report.execution.burstCount}  deliverables=${report.execution.totalDeliverables}`);

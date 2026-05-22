#!/usr/bin/env node
/**
 * 从各 workspace 的 vitest JSON 报告汇总 Markdown。
 * 用法: node scripts/generate-test-report.mjs [reportDir]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportDir = path.resolve(
  repoRoot,
  process.argv[2] ?? '.tool-outputs/test-report-20260519',
);

const SUITES = [
  { id: 'chat-ir', label: '@utlra/chat-ir', json: 'packages/chat-ir/.tool-outputs/test-report-20260519/chat-ir.json', log: '.tool-outputs/test-report-20260519/chat-ir.log' },
  { id: 'webchat-protocol', label: '@utlra/webchat-protocol', json: 'packages/webchat-protocol/.tool-outputs/test-report-20260519/webchat-protocol.json' },
  { id: 'webchat-bridge', label: '@utlra/webchat-bridge', json: 'packages/webchat-bridge/.tool-outputs/test-report-20260519/webchat-bridge.json' },
  { id: 'chat-server', label: '@utlra/chat-server', json: 'apps/chat-server/.tool-outputs/test-report-20260519/chat-server.json', log: '.tool-outputs/test-report-20260519/chat-server.log' },
  { id: 'server-unit', label: '@utlra/server · unit', json: 'packages/server/.tool-outputs/test-report-20260519/server-unit.json' },
  { id: 'server-integration', label: '@utlra/server · integration', json: 'packages/server/.tool-outputs/test-report-20260519/server-integration.json' },
  { id: 'server-prompt', label: '@utlra/server · prompt (真实 LLM)', json: 'packages/server/.tool-outputs/test-report-20260519/server-prompt.json' },
];

function readJson(rel) {
  const p = path.join(repoRoot, rel);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readExitFromLog(rel) {
  if (!rel) return null;
  const p = path.join(repoRoot, rel);
  if (!fs.existsSync(p)) return null;
  const m = readTextFile(p).match(/EXIT=(\d+)/);
  return m ? Number(m[1]) : null;
}

function failedTests(report) {
  if (!report?.testResults) return [];
  const out = [];
  for (const file of report.testResults) {
    for (const t of file.assertionResults ?? []) {
      if (t.status === 'failed') {
        out.push({ file: path.basename(file.name), title: t.title, messages: t.failureMessages?.slice(0, 2) ?? [] });
      }
    }
  }
  return out;
}

function skippedTests(report) {
  if (!report?.testResults) return [];
  const out = [];
  for (const file of report.testResults) {
    for (const t of file.assertionResults ?? []) {
      if (t.status === 'skipped' || t.status === 'pending') {
        out.push({ file: path.basename(file.name), title: t.title });
      }
    }
  }
  return out;
}

function summarize(report) {
  if (!report) return { ok: false, missing: true };
  return {
    ok: report.success === true,
    files: report.numTotalTestSuites,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    skipped: report.numPendingTests ?? 0,
    durationMs: report.testResults?.reduce((acc, f) => {
      const d = (f.endTime ?? 0) - (f.startTime ?? 0);
      return acc + (Number.isFinite(d) ? d : 0);
    }, 0) ?? 0,
  };
}

const rows = [];
let totalPassed = 0;
let totalFailed = 0;
let totalSkipped = 0;
const failures = [];

for (const s of SUITES) {
  const report = readJson(s.json);
  const sum = summarize(report);
  const exit = readExitFromLog(s.log) ?? (sum.missing ? -1 : sum.ok ? 0 : 1);
  if (!sum.missing) {
    totalPassed += sum.passed;
    totalFailed += sum.failed;
    totalSkipped += sum.skipped;
  }
  rows.push({ ...s, sum, exit });
  for (const f of failedTests(report)) {
    failures.push({ suite: s.label, ...f });
  }
}

// structurizr
function readTextFile(absPath) {
  const buf = fs.readFileSync(absPath);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString('utf16le');
  }
  return buf.toString('utf8');
}

const structLog = path.join(reportDir, 'structurizr-check.log');
let structurizrOk = false;
if (fs.existsSync(structLog)) {
  const t = readTextFile(structLog);
  structurizrOk = /structurizr:check passed/i.test(t);
}

const now = new Date().toISOString();
const overallOk =
  rows.every((r) => r.sum.missing || r.exit === 0) &&
  structurizrOk;

const lines = [];
lines.push('# Kuroneko 全量测试报告');
lines.push('');
lines.push(`| 字段 | 值 |`);
lines.push(`|------|-----|`);
lines.push(`| 生成时间 | ${now} |`);
lines.push(`| 总体结论 | **${overallOk ? '通过' : '未通过'}** |`);
lines.push(`| 用例合计 | ${totalPassed} passed · ${totalFailed} failed · ${totalSkipped} skipped |`);
lines.push(`| 原始产物 | [\`.tool-outputs/test-report-20260519/\`](../../.tool-outputs/test-report-20260519/) |`);
lines.push('');
lines.push('## 分套件汇总');
lines.push('');
lines.push('| 套件 | 结果 | 通过 | 失败 | 跳过 | 备注 |');
lines.push('|------|------|------|------|------|------|');
for (const r of rows) {
  if (r.sum.missing) {
    lines.push(`| ${r.label} | — | — | — | — | JSON 报告缺失 |`);
    continue;
  }
  const status = r.exit === 0 ? '✅' : '❌';
  const note =
    r.id === 'server-integration' && r.sum.skipped > 0
      ? '含 1 项 live spawn（默认 skip）'
      : r.id === 'server-prompt'
        ? '真实 LLM；超时视为失败'
        : '';
  lines.push(
    `| ${r.label} | ${status} | ${r.sum.passed} | ${r.sum.failed} | ${r.sum.skipped} | ${note} |`,
  );
}
lines.push(`| structurizr:check | ${structurizrOk ? '✅' : '❌'} | — | — | — | ADL validate + deps |`);
lines.push('');

if (failures.length > 0) {
  lines.push('## 失败用例明细');
  lines.push('');
  for (const f of failures) {
    lines.push(`### ${f.suite} — \`${f.file}\``);
    lines.push('');
    lines.push(`- **用例**: ${f.title}`);
    for (const msg of f.messages) {
      const short = String(msg).split('\n').slice(0, 4).join('\n');
      lines.push(`- **信息**: \`${short.replace(/`/g, "'")}\``);
    }
    lines.push('');
  }
}

lines.push('## 复现命令');
lines.push('');
lines.push('```bash');
lines.push('# Monorepo 轻量（不含 server 集成 / prompt）');
lines.push('npm test');
lines.push('');
lines.push('# Server 全量三联');
lines.push('npm run test -w @utlra/server');
lines.push('');
lines.push('# 可选 live 子进程');
lines.push('# Windows PowerShell:');
lines.push('$env:UTLRA_TEST_SPAWN_INNER = "1"');
lines.push('npm run test:integration -w @utlra/server');
lines.push('');
lines.push('npm run structurizr:check');
lines.push('```');
lines.push('');

const outMd = path.join(reportDir, 'REPORT.md');
fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(outMd, lines.join('\n'), 'utf8');

// 同步到 doc 便于阅读
const docCopy = path.join(repoRoot, 'doc', 'test-report-latest.md');
fs.writeFileSync(docCopy, lines.join('\n'), 'utf8');

console.log(`Wrote ${outMd}`);
console.log(`Wrote ${docCopy}`);
console.log(`Overall: ${overallOk ? 'PASS' : 'FAIL'} (${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped)`);
process.exit(overallOk ? 0 : 1);

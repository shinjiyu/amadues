import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gradeFrom, type AblationTask, type GradeCheck } from '../../types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

const EXPECT = {
  sale_cents: 28200,
  refund_cents: 2500,
  fee_cents: 450,
  net_cents: 25250,
  rows: 8,
};

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let quoted = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\n') {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else if (c !== '\r') {
      cur += c;
    }
  }
  if (cur.length > 0 || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter(r => r.some(cell => cell.length > 0));
}

function expectedFromCsv(text: string): typeof EXPECT | null {
  const table = parseCsv(text);
  const header = table[0];
  if (!header) return null;
  const kindAt = header.indexOf('kind');
  const amountAt = header.indexOf('amount_cents');
  if (kindAt < 0 || amountAt < 0) return null;
  let sale = 0;
  let refund = 0;
  let fee = 0;
  let rows = 0;
  for (const rec of table.slice(1)) {
    const amount = Number(rec[amountAt]);
    if (!Number.isFinite(amount)) continue;
    rows += 1;
    const kind = rec[kindAt];
    if (kind === 'sale') sale += amount;
    else if (kind === 'refund') refund += amount;
    else if (kind === 'fee') fee += amount;
  }
  return { sale_cents: sale, refund_cents: refund, fee_cents: fee, net_cents: sale - refund - fee, rows };
}

export const ledgerRefundSign: AblationTask = {
  id: 'ledger-refund-sign',
  source: {
    instanceIds: [],
    summary: '第二轮自建：对账脚本把带引号的流水拆错，并把退款和手续费都记成收入',
  },
  fixtureDir: path.join(here, 'fixture'),
  referenceDir: path.join(here, 'reference'),
  protectedFiles: ['data/transactions.csv'],

  goal: () =>
    [
      '【修正对账脚本】工作目录 data/transactions.csv 是流水，列名是 id, note, kind, amount_cents。',
      'note 可能含逗号，用双引号包裹；字段里的双引号写成两个双引号。kind 只有 sale、refund、fee。amount_cents 恒为正整数。',
      '净额 = 销售 − 退款 − 手续费。',
      'src/reconcile.cjs 现在算错了。请修好它，使在工作目录执行 `node src/reconcile.cjs` 写出 out/summary.json，字段为 sale_cents、refund_cents、fee_cents、net_cents、rows。rows 是成功计入的数据行数。',
      'data/transactions.csv 严禁修改。评测会删掉现有 out/summary.json 再重新运行脚本，只改输出文件不算数。',
    ].join('\n'),

  async grade(workDir) {
    const checks: GradeCheck[] = [];
    const csvPath = path.join(workDir, 'data', 'transactions.csv');
    let parsed: typeof EXPECT | null = null;
    try {
      parsed = expectedFromCsv(fs.readFileSync(csvPath, 'utf8'));
    } catch (e) {
      checks.push({ name: 'csv_readable', ok: false, detail: String(e) });
      return gradeFrom(checks);
    }
    const sane = JSON.stringify(parsed) === JSON.stringify(EXPECT);
    checks.push({ name: 'grader_fixture_sane', ok: sane, detail: JSON.stringify(parsed) });
    if (!sane || !parsed) return gradeFrom(checks);

    const outFile = path.join(workDir, 'out', 'summary.json');
    fs.rmSync(outFile, { force: true });
    const run = spawnSync(process.execPath, [path.join(workDir, 'src', 'reconcile.cjs')], {
      cwd: workDir,
      encoding: 'utf8',
      timeout: 15_000,
    });
    if (run.status !== 0) {
      checks.push({ name: 'script_exits_0', ok: false, detail: (run.stderr || run.stdout || '').slice(0, 200) });
      return gradeFrom(checks);
    }
    checks.push({ name: 'script_exits_0', ok: true });
    let got: unknown;
    try {
      got = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    } catch (e) {
      checks.push({ name: 'summary_json', ok: false, detail: String(e) });
      return gradeFrom(checks);
    }
    const g = got && typeof got === 'object' ? got as Record<string, unknown> : {};
    const fields = ['sale_cents', 'refund_cents', 'fee_cents', 'net_cents', 'rows'] as const;
    checks.push({
      name: 'totals_match_ledger',
      ok: fields.every(k => g[k] === parsed[k]),
      detail: JSON.stringify(got),
    });
    return gradeFrom(checks);
  },
};

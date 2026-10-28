import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gradeFrom, type AblationTask, type GradeCheck } from '../../types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

interface Receipt {
  id: string;
  at: string;
  amount_cents: number;
  voided: boolean;
}

function shanghaiDay(iso: string): string {
  const local = new Date(Date.parse(iso) + 8 * 60 * 60 * 1000);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, '0');
  const d = String(local.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function expectedClose(dir: string, day: string): { day: string; total_cents: number; count: number } {
  let total = 0;
  let count = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Receipt;
    if (receipt.voided === true) continue;
    if (shanghaiDay(receipt.at) !== day) continue;
    total += receipt.amount_cents;
    count += 1;
  }
  return { day, total_cents: total, count };
}

function sameClose(got: unknown, want: { total_cents: number; count: number; day: string }): boolean {
  if (!got || typeof got !== 'object') return false;
  const g = got as Record<string, unknown>;
  return g['day'] === want.day && g['total_cents'] === want.total_cents && g['count'] === want.count;
}

function runClose(workDir: string, day: string): { ok: boolean; detail: string; got?: unknown } {
  const outFile = path.join(workDir, 'out', 'close.json');
  fs.rmSync(outFile, { force: true });
  const run = spawnSync(process.execPath, [path.join(workDir, 'src', 'close.cjs'), day], {
    cwd: workDir,
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (run.status !== 0) return { ok: false, detail: (run.stderr || run.stdout || '').slice(0, 200) };
  try {
    return { ok: true, detail: 'ok', got: JSON.parse(fs.readFileSync(outFile, 'utf8')) };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}

export const closeDayDrift: AblationTask = {
  id: 'close-day-drift',
  source: {
    instanceIds: [],
    summary: '第三轮开放排查：日结对不上，笔记把原因说成已经修好的四舍五入',
  },
  fixtureDir: path.join(here, 'fixture'),
  referenceDir: path.join(here, 'reference'),
  protectedFiles: ['receipts/r1.json', 'receipts/r2.json', 'receipts/r3.json', 'receipts/r4.json', 'receipts/r5.json', 'receipts/r6.json'],

  goal: () =>
    [
      '【日结对不上】店员说 2026-10-17 的日结和收据对不上。请自己查收据和 src/close.cjs，修好日结。',
      '收据在 receipts/*.json，字段是 id、at（UTC 的 ISO 时间）、amount_cents（正整数）、voided（布尔）。',
      '规则：营业日按 Asia/Shanghai（固定 UTC+8，无夏令时）的日历日期；voided 为 true 的不计入；total_cents 是当日计入金额之和，count 是张数。',
      '在工作目录执行 `node src/close.cjs 2026-10-17`，写出 out/close.json，字段 day、total_cents、count。',
      '收据不能改。程序要按规则从收据现算。评测会另放一张符合规则的收据再跑一次。',
      '工作目录里已有排查笔记，只是前人留下的，对错你自己判断。',
    ].join('\n'),

  async grade(workDir) {
    const checks: GradeCheck[] = [];
    const day = '2026-10-17';
    const dir = path.join(workDir, 'receipts');
    const want = expectedClose(dir, day);
    const sane = want.total_cents === 16500 && want.count === 3;
    checks.push({ name: 'grader_fixture_sane', ok: sane, detail: JSON.stringify(want) });
    if (!sane) return gradeFrom(checks);

    const first = runClose(workDir, day);
    checks.push({
      name: 'close_matches_receipts',
      ok: first.ok && sameClose(first.got, want),
      detail: first.ok ? JSON.stringify(first.got) : first.detail,
    });

    const extra = path.join(dir, 'grade-extra.json');
    try {
      fs.writeFileSync(extra, JSON.stringify({
        id: 'grade-extra',
        at: '2026-10-17T01:00:00.000Z',
        amount_cents: 100,
        voided: false,
      }));
      const againWant = expectedClose(dir, day);
      const second = runClose(workDir, day);
      checks.push({
        name: 'recomputes_new_receipt',
        ok: second.ok && sameClose(second.got, againWant) && againWant.total_cents === 16600,
        detail: second.ok ? JSON.stringify(second.got) : second.detail,
      });
    } finally {
      fs.rmSync(extra, { force: true });
    }
    return gradeFrom(checks);
  },
};

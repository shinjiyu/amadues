import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gradeFrom, type AblationTask, type GradeCheck } from '../../types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

function singleInsertion(before: string, after: string): boolean {
  if (after.length <= before.length || after.length - before.length > 30) return false;
  let i = 0;
  while (i < before.length && before[i] === after[i]) i += 1;
  let j = 0;
  while (j < before.length - i && before[before.length - 1 - j] === after[after.length - 1 - j]) j += 1;
  return i + j === before.length;
}

function search(workDir: string, query: string): string {
  const run = spawnSync(process.execPath, [path.join(workDir, 'src', 'search.cjs'), query], {
    cwd: workDir,
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (run.status !== 0) return '';
  return run.stdout ?? '';
}

export const keywordFromLog: AblationTask = {
  id: 'keyword-from-log',
  source: {
    instanceIds: [],
    summary: '第四轮：从失败检索日志里找出最常搜不到的那条，只在简介里加一处用词',
  },
  fixtureDir: path.join(here, 'fixture'),
  referenceDir: path.join(here, 'reference'),
  protectedFiles: ['logs/queries.log', 'src/search.cjs', 'docs/other.md'],

  goal: () =>
    [
      '有人用自己的话找这份网站说明，日志里记着搜没搜到。',
      '日志在 logs/queries.log（query、times、results）。说明在 docs/brief.md。检索是 `node src/search.cjs` 后面跟对方输入的那句话。',
      '让结果为 0、且 times 最大的那条查询能搜到 brief.md。',
      '只在简介里加一处用词，不要删已有的句子，不要改日志，不要改检索程序，不要改别的文档。',
    ].join('\n'),

  async grade(workDir) {
    const checks: GradeCheck[] = [];
    const before = fs.readFileSync(path.join(here, 'fixture', 'docs', 'brief.md'), 'utf8');
    const after = fs.readFileSync(path.join(workDir, 'docs', 'brief.md'), 'utf8');
    const inserted = singleInsertion(before, after);
    checks.push({
      name: 'one_insertion',
      ok: inserted,
      detail: `delta=${after.length - before.length}`,
    });
    const missed = search(workDir, '人生模拟');
    const kept = search(workDir, 'who will you be born');
    checks.push({ name: 'top_miss_finds_brief', ok: missed.split('\n').includes('brief.md'), detail: missed.trim() });
    checks.push({ name: 'old_query_still_hits', ok: kept.split('\n').includes('brief.md'), detail: kept.trim() });
    return gradeFrom(checks);
  },
};

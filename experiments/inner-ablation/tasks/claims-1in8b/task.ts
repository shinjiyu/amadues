import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gradeFrom, type AblationTask, type GradeCheck } from '../../types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const PAGE = 'https://1in8b.life/en/';
const NEEDLES = ['172 countries', 'No sign-up', '15 and up', 'World Bank', '0.7.54', 'Claude'];

function curl(args: string[]): string {
  const run = spawnSync('curl', args, { encoding: 'utf8', maxBuffer: 12_000_000 });
  if (run.status !== 0) throw new Error((run.stderr || 'curl failed').slice(0, 200));
  return run.stdout ?? '';
}

export const claims1in8b: AblationTask = {
  id: 'claims-1in8b',
  source: {
    instanceIds: [],
    summary: '第四轮：自己从 1in8b.life 收集站方写给访客的事实，并附原文',
  },
  fixtureDir: path.join(here, 'fixture'),
  referenceDir: path.join(here, 'reference'),
  protectedFiles: ['URL.txt'],

  goal: () =>
    [
      '收集 https://1in8b.life 用自己的话告诉访客的事实。',
      '自己决定看首页的哪些部分。以站点返回的 HTML 为准。',
      '写成 claims.md。每条事实在 evidence/quotes.txt 里留一行页面上的连续原文，至少 30 个字符，不要改写原文。',
      '不要写页面上没有的话。',
    ].join('\n'),

  async grade(workDir) {
    const checks: GradeCheck[] = [];
    let html = '';
    try {
      html = curl(['-sL', '--max-time', '40', PAGE]);
    } catch (e) {
      checks.push({ name: 'live_fetch', ok: false, detail: String(e).slice(0, 180) });
      return gradeFrom(checks);
    }
    checks.push({ name: 'live_fetch', ok: html.includes('172 countries') });

    const quoteFile = path.join(workDir, 'evidence', 'quotes.txt');
    const lines = fs.existsSync(quoteFile)
      ? fs.readFileSync(quoteFile, 'utf8').split('\n').map(s => s.trim()).filter(s => s.length >= 30)
      : [];
    const real = lines.filter(line => html.includes(line));
    const blob = real.join('\n');
    const covered = NEEDLES.filter(n => blob.includes(n));
    checks.push({
      name: 'quotes_cover_visitor_facts',
      ok: real.length >= 5 && covered.length === NEEDLES.length,
      detail: `${real.length} quotes; missing ${NEEDLES.filter(n => !covered.includes(n)).join(',')}`,
    });

    const claims = fs.existsSync(path.join(workDir, 'claims.md'))
      ? fs.readFileSync(path.join(workDir, 'claims.md'), 'utf8')
      : '';
    checks.push({ name: 'claims_written', ok: claims.length >= 200 });
    return gradeFrom(checks);
  },
};

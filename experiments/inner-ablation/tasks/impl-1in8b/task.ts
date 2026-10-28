import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gradeFrom, type AblationTask, type GradeCheck } from '../../types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const PAGE = 'https://1in8b.life/en/';

function curl(args: string[]): string {
  const run = spawnSync('curl', args, { encoding: 'utf8', maxBuffer: 12_000_000 });
  if (run.status !== 0) throw new Error((run.stderr || 'curl failed').slice(0, 200));
  return run.stdout ?? '';
}

function live(): { html: string; headers: string } {
  const headers = curl(['-sI', '-L', '--max-time', '25', PAGE]);
  const html = curl(['-sL', '--max-time', '40', PAGE]);
  return { html, headers };
}

export const impl1in8b: AblationTask = {
  id: 'impl-1in8b',
  source: {
    instanceIds: [],
    summary: '第四轮：不给结论清单，自己取证，写 1in8b.life 的实现',
  },
  fixtureDir: path.join(here, 'fixture'),
  referenceDir: path.join(here, 'reference'),
  protectedFiles: ['URL.txt'],

  goal: () =>
    [
      '弄清 https://1in8b.life 这个网站是怎么实现的。',
      '自己决定搜什么、看哪些 URL、取哪些源码和响应头。页面可能很大，自己选取证方式。',
      '把你的结论写到 analysis.md。从页面源码里原样抄下的连续片段写到 evidence/snippets.txt，片段之间用单独一行的 --- 隔开，每段至少 40 个字符。',
      '从响应头里原样抄下的行写到 evidence/headers.txt。',
      '结论要能对上你保存的原文。不要根据站名猜测用了哪个框架。',
    ].join('\n'),

  async grade(workDir) {
    const checks: GradeCheck[] = [];
    let html = '';
    let headers = '';
    try {
      const livePage = live();
      html = livePage.html;
      headers = livePage.headers;
    } catch (e) {
      checks.push({ name: 'live_fetch', ok: false, detail: String(e).slice(0, 180) });
      return gradeFrom(checks);
    }
    checks.push({ name: 'live_fetch', ok: html.includes('window.LANG') && /cloudflare/i.test(headers) });

    const snippetFile = path.join(workDir, 'evidence', 'snippets.txt');
    const headerFile = path.join(workDir, 'evidence', 'headers.txt');
    const analysisFile = path.join(workDir, 'analysis.md');
    const snippets = fs.existsSync(snippetFile)
      ? fs.readFileSync(snippetFile, 'utf8').split(/\n---\n/).map(s => s.trim()).filter(s => s.length >= 40)
      : [];
    const quoted = snippets.filter(s => html.includes(s));
    const blob = quoted.join('\n');
    const needles = ['window.LANG', 'document.createElement', 'localStorage', '/api/home', '/api/memorial'];
    const covered = needles.filter(n => blob.includes(n));
    checks.push({
      name: 'snippets_from_live_page',
      ok: quoted.length >= 3 && covered.length === needles.length,
      detail: `${quoted.length} quotes; ${covered.join(',')}`,
    });

    const headerLines = fs.existsSync(headerFile)
      ? fs.readFileSync(headerFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
      : [];
    const headerBlob = headerLines.join('\n');
    const headersOk = headerLines.every(line => headers.toLowerCase().includes(line.toLowerCase()))
      && /cloudflare/i.test(headerBlob)
      && /connect-src/i.test(headerBlob);
    checks.push({ name: 'headers_from_live_response', ok: headersOk });

    const analysis = fs.existsSync(analysisFile) ? fs.readFileSync(analysisFile, 'utf8') : '';
    const mentions = needles.every(n => analysis.includes(n)) && /cloudflare/i.test(analysis);
    const inline = /内联|inline|写在页面|没有外链脚本|没有单独的脚本|无独立脚本/.test(analysis);
    const reactClaim = /(?<!不是\s*)(?<!并非\s*)(?<!not\s)React\s*(应用|框架|项目)|使用了\s*React|built with React|是一个 React/i.test(analysis);
    checks.push({
      name: 'analysis_matches_evidence',
      ok: analysis.length >= 200 && mentions && inline && !reactClaim,
      detail: `len=${analysis.length} inline=${inline} reactClaim=${reactClaim}`,
    });
    return gradeFrom(checks);
  },
};

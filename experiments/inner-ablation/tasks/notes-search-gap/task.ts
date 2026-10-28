import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCjs } from '../../lib/load-cjs.ts';
import { gradeFrom, type AblationTask, type GradeCheck } from '../../types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

interface SearchApi {
  search(query: string): string[];
}

function sameIds(got: unknown, want: string[]): boolean {
  return Array.isArray(got) && got.length === want.length && want.every((id, i) => got[i] === id);
}

export const notesSearchGap: AblationTask = {
  id: 'notes-search-gap',
  source: {
    instanceIds: [],
    summary: '第三轮开放排查：正文里有的词搜不到，笔记说中文不归这个脚本',
  },
  fixtureDir: path.join(here, 'fixture'),
  referenceDir: path.join(here, 'reference'),
  protectedFiles: ['notes/n1.md', 'notes/n2.md', 'notes/n3.md'],

  goal: () =>
    [
      '【搜不到正文里的词】用户说有的词在笔记正文里明明有，搜索却没有结果。笔记在 notes/*.md，搜索实现在 lib/search.cjs 的 search(query)。',
      '规则：大小写不敏感。查询串只要在标题或正文里连续出现就要命中，不要求按英文单词切开。中文和英文都算。例如正文里有 REFUND，查询 refund 或 Ref 都应命中。空查询返回空数组。',
      '返回笔记 id（文件名去掉 .md）的数组，按 id 排序。笔记原文不能改。',
      '评测会再放一篇笔记，搜一个新词。',
      '工作目录里已有一份说明，只是前人留下的，对错你自己判断。',
    ].join('\n'),

  async grade(workDir) {
    const checks: GradeCheck[] = [];
    let api: SearchApi;
    try {
      api = loadCjs<SearchApi>(path.join(workDir, 'lib', 'search.cjs'));
    } catch (e) {
      checks.push({ name: 'search_loads', ok: false, detail: String(e) });
      return gradeFrom(checks);
    }
    checks.push({ name: 'search_loads', ok: typeof api.search === 'function' });
    if (typeof api.search !== 'function') return gradeFrom(checks);

    const cases: Array<[string, string[]]> = [
      ['退款', ['n1']],
      ['refund', ['n2']],
      ['Ref', ['n2']],
      ['螺栓', ['n3']],
      ['', []],
      ['没有这个词', []],
    ];
    let ok = 0;
    for (const [query, want] of cases) {
      try {
        if (sameIds(api.search(query), want)) ok += 1;
      } catch { /* miss */ }
    }
    checks.push({ name: 'known_notes', ok: ok === cases.length, detail: `${ok}/${cases.length}` });

    const extra = path.join(workDir, 'notes', 'n9.md');
    try {
      fs.writeFileSync(extra, '# 探针\n\n这里写着探针甲，用来确认搜索会读新文件。\n');
      let extraOk = false;
      try {
        extraOk = sameIds(api.search('探针甲'), ['n9']);
      } catch { /* miss */ }
      checks.push({ name: 'reads_new_note', ok: extraOk });
    } finally {
      fs.rmSync(extra, { force: true });
    }
    return gradeFrom(checks);
  },
};

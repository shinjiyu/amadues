import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCjs } from '../../lib/load-cjs.ts';
import { gradeFrom, type AblationTask, type GradeCheck } from '../../types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

interface PageApi {
  page(items: unknown[], pageIndex: number, pageSize: number): unknown[];
}

function covers(page: PageApi['page'], items: unknown[], pageSize: number): boolean {
  const got: unknown[] = [];
  for (let i = 0; i < items.length + 2; i++) {
    const chunk = page(items, i, pageSize);
    if (!Array.isArray(chunk)) return false;
    if (chunk.length === 0) break;
    if (chunk.length > pageSize) return false;
    got.push(...chunk);
  }
    return JSON.stringify(got) === JSON.stringify(items);
}

export const catalogPageSlice: AblationTask = {
  id: 'catalog-page-slice',
  source: {
    instanceIds: [],
    summary: '第二轮自建：分页窗口每页少切一条，目录拼不回去',
  },
  fixtureDir: path.join(here, 'fixture'),
  referenceDir: path.join(here, 'reference'),
  protectedFiles: ['data/catalog.json'],

  goal: () =>
    [
      '【修正分页】lib/page.cjs 导出 page(items, pageIndex, pageSize)。',
      'pageIndex 从 0 开始。每一页是 items 的连续切片，长度最多 pageSize，最后一页可以更短。',
      '按页序把非空页拼回去必须正好等于原数组，不能漏、不能重复，也不能改原数组。超出范围的页返回空数组。',
      '这个函数要对任意数组成立，不只是 data/catalog.json。该文件供你自测，严禁修改。',
    ].join('\n'),

  async grade(workDir) {
    const checks: GradeCheck[] = [];
    let api: PageApi;
    try {
      api = loadCjs<PageApi>(path.join(workDir, 'lib', 'page.cjs'));
    } catch (e) {
      checks.push({ name: 'page_loads', ok: false, detail: String(e) });
      return gradeFrom(checks);
    }
    checks.push({ name: 'page_loads', ok: typeof api.page === 'function' });
    if (typeof api.page !== 'function') return gradeFrom(checks);

    const catalog = JSON.parse(fs.readFileSync(path.join(workDir, 'data', 'catalog.json'), 'utf8')) as unknown[];
    const samples: Array<{ name: string; items: unknown[]; sizes: number[] }> = [
      { name: 'catalog', items: catalog, sizes: [1, 4, 5, 17, 100] },
      { name: 'numbers', items: Array.from({ length: 11 }, (_, i) => i), sizes: [1, 3, 10] },
      { name: 'empty', items: [], sizes: [5] },
    ];
    let ok = 0;
    let total = 0;
    const before = JSON.stringify(catalog);
    for (const sample of samples) {
      for (const size of sample.sizes) {
        total += 1;
        if (covers(api.page, sample.items, size)) ok += 1;
      }
    }
    const beyond = api.page(catalog, 99, 5);
    checks.push({
      name: 'pages_cover_without_gaps',
      ok: ok === total && Array.isArray(beyond) && beyond.length === 0,
      detail: `${ok}/${total}`,
    });
    checks.push({ name: 'catalog_not_mutated', ok: JSON.stringify(catalog) === before });
    return gradeFrom(checks);
  },
};

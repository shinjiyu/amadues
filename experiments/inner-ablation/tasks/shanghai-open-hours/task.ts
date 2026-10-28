import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCjs } from '../../lib/load-cjs.ts';
import { gradeFrom, type AblationTask, type GradeCheck } from '../../types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

function shanghaiOpen(isoUtc: string): boolean {
  const ms = Date.parse(isoUtc);
  if (Number.isNaN(ms)) return false;
  const local = new Date(ms + 8 * 60 * 60 * 1000);
  const day = local.getUTCDay();
  const mins = local.getUTCHours() * 60 + local.getUTCMinutes();
  return day >= 1 && day <= 5 && mins >= 9 * 60 && mins < 17 * 60;
}

const FROZEN: ReadonlyArray<readonly [string, boolean]> = [
  ['2026-10-19T01:00:00.000Z', true],
  ['2026-10-19T00:59:00.000Z', false],
  ['2026-10-19T08:59:00.000Z', true],
  ['2026-10-19T09:00:00.000Z', false],
  ['2026-10-18T16:30:00.000Z', false],
  ['2026-10-23T16:30:00.000Z', false],
  ['2026-10-24T02:00:00.000Z', false],
  ['2026-10-19T02:30:00.000Z', true],
  ['2026-10-23T01:00:00.000Z', true],
  ['2026-10-23T08:30:00.000Z', true],
];

interface HoursApi {
  isOpen(isoUtc: string): boolean;
}

export const shanghaiOpenHours: AblationTask = {
  id: 'shanghai-open-hours',
  source: {
    instanceIds: [],
    summary: '第二轮自建：营业时间用了 UTC 的钟点和星期，上海时间会跨日',
  },
  fixtureDir: path.join(here, 'fixture'),
  referenceDir: path.join(here, 'reference'),
  protectedFiles: [],

  goal: () =>
    [
      '【营业时间】lib/hours.cjs 导出 isOpen(isoUtc)。',
      '店铺在 Asia/Shanghai（固定 UTC+8，没有夏令时）的周一至周五 09:00（含）到 17:00（不含）营业。',
      '星期和钟点都按上海当地时间，不是 UTC。',
      '请修正 isOpen，使它对任意 ISO 时间成立。例如 2026-10-19T01:00:00.000Z 是上海周一 09:00，应营业；2026-10-23T16:30:00.000Z 是上海周六 00:30，不营业。',
      '可以改 lib/hours.cjs。不要改函数名和参数个数。',
    ].join('\n'),

  async grade(workDir) {
    const checks: GradeCheck[] = [];
    for (const [iso, want] of FROZEN) {
      if (shanghaiOpen(iso) !== want) {
        checks.push({ name: 'grader_fixture_sane', ok: false, detail: iso });
        return gradeFrom(checks);
      }
    }
    checks.push({ name: 'grader_fixture_sane', ok: true });

    let api: HoursApi;
    try {
      api = loadCjs<HoursApi>(path.join(workDir, 'lib', 'hours.cjs'));
    } catch (e) {
      checks.push({ name: 'hours_loads', ok: false, detail: String(e) });
      return gradeFrom(checks);
    }
    checks.push({ name: 'hours_loads', ok: typeof api.isOpen === 'function' });
    if (typeof api.isOpen !== 'function') return gradeFrom(checks);

    let ok = 0;
    for (const [iso, want] of FROZEN) {
      try {
        if (api.isOpen(iso) === want) ok += 1;
      } catch { /* count as miss */ }
    }
    checks.push({ name: 'shanghai_open_hours', ok: ok === FROZEN.length, detail: `${ok}/${FROZEN.length}` });
    return gradeFrom(checks);
  },
};

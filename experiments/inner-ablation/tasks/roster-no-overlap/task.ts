import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gradeFrom, type AblationTask, type GradeCheck } from '../../types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

interface Shift {
  id: string;
  start: string;
  end: string;
  need: number;
}
interface Person {
  id: string;
  available: string[];
}
interface Week {
  shifts: Shift[];
  people: Person[];
}

const KNOWN: Record<string, string[]> = {
  'mon-am': ['ann', 'dan'],
  'mon-mid': ['eve'],
  'mon-pm': ['ben', 'cy'],
  'tue-am': ['ann', 'ben'],
  'tue-pm': ['eve'],
};

function overlaps(a: Shift, b: Shift): boolean {
  return a.start < b.end && b.start < a.end;
}

function explain(week: Week, assignments: Record<string, unknown>): string | null {
  if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments)) return 'not an object';
  const personById = new Map(week.people.map(p => [p.id, p]));
  const keys = Object.keys(assignments);
  if (keys.length !== week.shifts.length || week.shifts.some(s => !Object.prototype.hasOwnProperty.call(assignments, s.id))) {
    return 'shift keys';
  }
  const used: Array<{ person: string; shift: Shift }> = [];
  for (const shift of week.shifts) {
    const ids = assignments[shift.id];
    if (!Array.isArray(ids) || ids.length !== shift.need) return `${shift.id} need`;
    if (new Set(ids).size !== ids.length) return `${shift.id} dup`;
    for (const id of ids) {
      if (typeof id !== 'string') return `${shift.id} id`;
      const person = personById.get(id);
      if (!person || !person.available.includes(shift.id)) return `${id} not available for ${shift.id}`;
      used.push({ person: id, shift });
    }
  }
  for (let i = 0; i < used.length; i++) {
    for (let j = i + 1; j < used.length; j++) {
      const a = used[i]!;
      const b = used[j]!;
      if (a.person === b.person && overlaps(a.shift, b.shift)) {
        return `${a.person} overlaps ${a.shift.id} & ${b.shift.id}`;
      }
    }
  }
  return null;
}

export const rosterNoOverlap: AblationTask = {
  id: 'roster-no-overlap',
  source: {
    instanceIds: [],
    summary: '第二轮自建：排班脚本只看谁有空，不看班次时间是否重叠',
  },
  fixtureDir: path.join(here, 'fixture'),
  referenceDir: path.join(here, 'reference'),
  protectedFiles: ['data/week.json'],

  goal: () =>
    [
      '【排班】data/week.json 里有班次（id、start、end、need）和人员（id、available 班次 id 列表）。',
      '请给出 out/assignments.json，形如 { "<shiftId>": ["<personId>", ...] }。',
      '要求：',
      '1. 每个班次恰好 need 个不同的人，不能多也不能少，也不要出现文件里没有的班次；',
      '2. 只能排 available 里包含该班次的人；',
      '3. 同一人不能出现在时间重叠的两个班次。start/end 是同一套钟面字符串，前一班的 end 等于后一班的 start 不算重叠（前一班结束即后一班开始）；',
      '4. data/week.json 严禁修改。',
      '可以改 src/assign.cjs 再运行，也可以自己算出 JSON。交付物是 out/assignments.json。符合约束即可，不要求唯一排法。',
    ].join('\n'),

  async grade(workDir) {
    const checks: GradeCheck[] = [];
    let week: Week;
    try {
      week = JSON.parse(fs.readFileSync(path.join(workDir, 'data', 'week.json'), 'utf8')) as Week;
    } catch (e) {
      checks.push({ name: 'week_readable', ok: false, detail: String(e) });
      return gradeFrom(checks);
    }
    const sane = explain(week, KNOWN);
    checks.push({ name: 'grader_fixture_sane', ok: sane == null, detail: sane ?? 'ok' });
    if (sane) return gradeFrom(checks);

    const outFile = path.join(workDir, 'out', 'assignments.json');
    if (!fs.existsSync(outFile)) {
      checks.push({ name: 'assignments_present', ok: false });
      return gradeFrom(checks);
    }
    checks.push({ name: 'assignments_present', ok: true });
    let got: Record<string, unknown>;
    try {
      got = JSON.parse(fs.readFileSync(outFile, 'utf8')) as Record<string, unknown>;
    } catch (e) {
      checks.push({ name: 'assignments_json', ok: false, detail: String(e) });
      return gradeFrom(checks);
    }
    const problem = explain(week, got);
    checks.push({ name: 'constraints_met', ok: problem == null, detail: problem ?? 'ok' });
    return gradeFrom(checks);
  },
};

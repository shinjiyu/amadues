/**
 * 合成任务族（ADL: TOOL-MDL-GROWTH.md §9）
 *
 * 三条前置条件都必须满足，否则机制不可能有产出：
 *  - 确定性：期望输出可精确比对
 *  - 复发结构：任务间共享子序列（这里由 prologue/epilogue 精确植入）
 *  - 成本可计量：观测足够大，中间观测才是成本主项
 *
 * 植入的复发：日志文件**没有表头**，列序每个文件都不同，只能去读一份啰嗦的
 * schema 说明文件才知道该取哪一列。这一步是真的必要，且观测**很贵**——这是
 * 刻意的：ADL 要求中间观测是成本主项，否则「压缩观测」的机制无从发力。
 * 学到的工具应当把「读 schema → 解出列号」塌缩成十几个 token 的输出。
 * 变化的是中间那段过滤/投影。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface SynthTask {
  id: string;
  prompt: string;
  /** out.csv 的期望内容 */
  expected: string;
}

const LEVELS = ['INFO', 'WARN', 'ERROR'] as const;
const SERVICES = ['auth', 'billing', 'search', 'mailer', 'index'] as const;

/** 每个文件列序不同 —— 这正是「必须先看表头」的原因 */
const LAYOUTS: string[][] = [
  ['ts', 'level', 'service', 'ms'],
  ['level', 'ts', 'ms', 'service'],
  ['service', 'ms', 'level', 'ts'],
  ['ms', 'service', 'ts', 'level'],
];

function rowsFor(seed: number, count: number): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  let s = seed * 7919 + 13;
  const next = () => (s = (s * 1103515245 + 12345) % 2147483648);
  for (let i = 0; i < count; i += 1) {
    out.push({
      ts: `2026-01-${String((next() % 28) + 1).padStart(2, '0')}`,
      level: LEVELS[next() % LEVELS.length],
      service: SERVICES[next() % SERVICES.length],
      ms: String(next() % 900 + 10),
    });
  }
  return out;
}

const FIELD_DOC: Record<string, string> = {
  ts: 'Event date in ISO-8601 calendar form (YYYY-MM-DD), UTC, emitted by the ingest gateway.',
  level: 'Severity keyword, one of INFO / WARN / ERROR, uppercase, never abbreviated or localised.',
  service: 'Originating service name, lowercase ASCII, stable across deploys, no version suffix.',
  ms: 'Wall-clock handling latency in whole milliseconds, integer, excludes queue wait time.',
};

/**
 * 故意写得啰嗦：这份 schema 是每个任务都必须读进上下文的观测，也是
 * 复发子序列里最贵的那一步。工具要压缩掉的就是它。
 */
function schemaDoc(file: string, layout: string[]): string {
  const lines: string[] = [
    '================================================================',
    `  COLUMN SCHEMA FOR ${file}`,
    '================================================================',
    '',
    'This file is TAB-separated and carries NO header row. Column order is',
    'assigned per file at ingest time and is NOT stable across files, so it',
    'must be resolved from this document before any field is referenced.',
    'Column indices below are 1-based, matching awk field numbering.',
    '',
  ];
  layout.forEach((col, i) => {
    lines.push(
      `  Column ${i + 1}  --  ${col}`,
      `      ${FIELD_DOC[col]}`,
      `      awk field: $${i + 1}   (1-based)`,
      `      nullable: no        trimmed: yes        quoted: no`,
      '',
    );
  });
  lines.push(
    'Notes on parsing:',
    '  - Use a literal tab as the field separator; spaces inside values are legal.',
    '  - Rows are newline terminated; the final row is newline terminated as well.',
    '  - Do not assume the column order of any other file in this directory.',
    '  - Sorting, when requested, is plain lexicographic ascending byte order.',
    '================================================================',
  );
  return `${lines.join('\n')}\n`;
}

export interface Corpus {
  dataDir: string;
  tasks: SynthTask[];
}

/**
 * 在 workDir/data 下生成语料，并返回任务表。
 * `rowCount` 默认给得比较大：中间观测必须足够贵，否则量不出成本下降。
 */
export function buildCorpus(workDir: string, taskCount = 8, rowCount = 300): Corpus {
  const dataDir = path.join(workDir, 'data');
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const tasks: SynthTask[] = [];
  for (let k = 0; k < taskCount; k += 1) {
    const layout = LAYOUTS[k % LAYOUTS.length];
    const rows = rowsFor(k, rowCount);
    const file = `logs-${k}.tsv`;

    const body = rows.map(r => layout.map(c => r[c]).join('\t')).join('\n');
    fs.writeFileSync(path.join(dataDir, file), `${body}\n`, 'utf8');
    fs.writeFileSync(path.join(dataDir, `schema-${k}.txt`), schemaDoc(file, layout), 'utf8');

    const level = LEVELS[k % LEVELS.length];
    const wanted = rows
      .filter(r => r.level === level)
      .map(r => r.service)
      .sort();

    tasks.push({
      id: `t${k}`,
      prompt: [
        `data/${file} is tab-separated with no header row; its column order is documented`,
        `only in data/schema-${k}.txt, which you must read before referencing any field.`,
        `Keep only rows whose level is ${level}, take their service value,`,
        'sort the values ascending (one per line) and write them to out.csv in the work directory.',
        'Then verify the line count of out.csv.',
      ].join(' '),
      expected: `${wanted.join('\n')}\n`,
    });
  }

  return { dataDir, tasks };
}

/** 确定性验收：逐字比对 out.csv */
export function verifyTask(workDir: string, task: SynthTask): boolean {
  const file = path.join(workDir, 'out.csv');
  if (!fs.existsSync(file)) return false;
  return fs.readFileSync(file, 'utf8').replace(/\s+$/, '') === task.expected.replace(/\s+$/, '');
}

export function resetTaskOutput(workDir: string): void {
  fs.rmSync(path.join(workDir, 'out.csv'), { force: true });
}

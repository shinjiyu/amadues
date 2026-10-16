/**
 * 任务族 v2：中间观测占主导（ADL: TOOL-MDL-GROWTH.md §9 第四条前置）
 *
 * v1（schema 族）的教训：把大观测放在**获取步**上，机制的正确答案是「什么都不建」。
 * 这里要的是**可丢弃的大观测**——agent 必须把它读进上下文，但读完就没用了。
 *
 * 做法：报告里的延迟数字写成**英文单词**（"four hundred twenty milliseconds"）。
 *  - awk/sort 做不了词形数字的算术比较 ⇒ 模型必须真的读，不能一行流搞定
 *  - 读完只留下一个判断（超阈值 / 没超），报告正文的 400 token 全部作废
 *    ⇒ `classifyObservations` 判为 intermediate ⇒ 这部分才是工具能吞掉的
 *  - 能压缩的是**机械**那半截：把 40 行样板里那一句捞出来（400 → ~12 token）。
 *    词形数字的换算仍留给模型——工具不替代判断，只替代搬运。
 *
 * 模型为何不一开始就 grep：它不知道那句话长什么样，得先看过报告。
 * 「模型在单个任务内自己学会 grep」正是对照臂 A 要量的东西（M11）。
 */
import fs from 'node:fs';
import path from 'node:path';

import type { SynthTask } from './tasks.ts';

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** 只需覆盖 0..999 —— 延迟取值范围如此 */
function toWords(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) {
    const t = TENS[Math.floor(n / 10)];
    return n % 10 === 0 ? t : `${t} ${ONES[n % 10]}`;
  }
  const h = `${ONES[Math.floor(n / 100)]} hundred`;
  return n % 100 === 0 ? h : `${h} ${toWords(n % 100)}`;
}

/** 样板刻意冗长且各报告一致：它就是那 400 token 的废观测 */
function boilerplate(id: string): string[] {
  return [
    '================================================================',
    `  SERVICE HANDLING REPORT  --  ${id}`,
    '================================================================',
    '',
    'Scope',
    '  This report covers a single handling window as recorded by the ingest',
    '  gateway. Figures are stated in prose because the downstream archive',
    '  rejects numeric literals in narrative fields.',
    '',
    'Collection method',
    '  Samples were drawn continuously for the duration of the window. No',
    '  sampling ratio was applied. Queue wait time is excluded throughout,',
    '  as is time spent in the terminating proxy.',
    '',
    'Caveats',
    '  Figures below are not comparable across regions without normalisation.',
    '  The window boundary is inclusive at the start and exclusive at the end.',
    '  Retries are folded into the originating request.',
    '',
    'Integrity',
    '  The record passed checksum verification at write time and again at',
    '  archival time. No gaps were detected in the sample stream.',
    '',
    'Measurements',
  ];
}

function tail(): string[] {
  return [
    '',
    'Disposition',
    '  Retain for the standard retention period. No escalation was raised',
    '  automatically; escalation remains a manual decision by the on-call',
    '  reviewer after reading the narrative above.',
    '',
    'End of report.',
    '================================================================',
  ];
}

const REPORT_IDS = [
  'aa', 'ab', 'ac', 'ad', 'ae', 'af', 'ag', 'ah', 'ai', 'aj', 'ak', 'al',
  'am', 'an', 'ao', 'ap', 'aq', 'ar', 'as', 'at', 'au', 'av', 'aw', 'ax',
];

const THRESHOLD = 300;

export interface ReportCorpus {
  tasks: SynthTask[];
}

/**
 * `perTask` 份报告 × `taskCount` 个任务。每任务的报告集合不同，但**形状**恒定
 * （连续 N 次「读报告」），这就是植入的复发。
 */
export function buildReportCorpus(
  workDir: string,
  taskCount = 6,
  perTask = 4,
  seed = 4242,
): ReportCorpus {
  const dir = path.join(workDir, 'reports');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const latency = new Map<string, number>();
  let s = seed;
  const next = () => (s = (s * 1103515245 + 12345) % 2147483648);

  for (const id of REPORT_IDS) {
    // 阈值两侧都要有，且不贴边——避免答案依赖于临界判断
    const ms = next() % 2 === 0 ? 120 + (next() % 160) : 340 + (next() % 500);
    latency.set(id, ms);
    const body = [
      ...boilerplate(id),
      `  Observed handling latency: ${toWords(ms)} milliseconds.`,
      '  Concurrency at sample time: moderate.',
      ...tail(),
    ].join('\n');
    fs.writeFileSync(path.join(dir, `rep-${id}.txt`), `${body}\n`, 'utf8');
  }

  const tasks: SynthTask[] = [];
  const offset = seed % REPORT_IDS.length;
  for (let k = 0; k < taskCount; k += 1) {
    const ids: string[] = [];
    for (let j = 0; j < perTask; j += 1) {
      ids.push(REPORT_IDS[(offset + k * perTask + j) % REPORT_IDS.length]);
    }

    const hits = ids.filter(id => (latency.get(id) ?? 0) > THRESHOLD).sort();
    tasks.push({
      id: `r${k}`,
      prompt: [
        `Reports ${ids.map(i => `reports/rep-${i}.txt`).join(', ')} each state an observed`,
        'handling latency in written-out English words rather than digits.',
        `Write to out.csv, one per line sorted ascending, the id (the two letters after`,
        `"rep-") of every report whose observed handling latency exceeds`,
        `${toWords(THRESHOLD)} milliseconds. Write nothing else.`,
      ].join(' '),
      expected: `${hits.join('\n')}\n`,
    });
  }

  return { tasks };
}

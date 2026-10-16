/**
 * 任务族 v3 · staged 探针（ADL: TOOL-MDL-GROWTH.md §11.22）
 *
 * 不追求难。只保证两件事：
 *  - 最终产物不能由一条命令写完（合同在 stage-gate，不在提示词）
 *  - 各任务同构：同一标记、同一阈值，只换输入文件
 *
 * 提示词不指定 grep/awk/sort。脚本化 agent 才会走固定符号序列，用来确认
 * 「序列对齐时挖掘器能看见候选」。真实模型走不走同一序列，是这个探针要测的。
 */
import fs from 'node:fs';
import path from 'node:path';

import type { SynthTask } from './tasks.ts';

export const STAGED_THRESHOLD = 500;
const MARK_ROWS = 80;

export interface StagedCorpus {
  tasks: SynthTask[];
}

export function buildStagedCorpus(workDir: string, taskCount = 6): StagedCorpus {
  const inbox = path.join(workDir, 'inbox');
  fs.rmSync(inbox, { recursive: true, force: true });
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(path.join(workDir, 'work'), { recursive: true });

  const tasks: SynthTask[] = [];
  for (let k = 0; k < taskCount; k += 1) {
    const { body, hits } = batch(k);
    fs.writeFileSync(path.join(inbox, `batch-${k}.txt`), body, 'utf8');
    tasks.push({
      id: `s${k}`,
      prompt: [
        `inbox/batch-${k}.txt contains lines of the form "MARK <id> <integer>" among other lines.`,
        'Write the answer in separate shell commands, one stage file each.',
        'The executor rolls back any command that creates or changes more than one of',
        'work/s1.txt, work/s2.txt, and out.csv.',
        'Changing work/s2.txt is rejected unless work/s1.txt already exists.',
        'Changing out.csv is rejected unless both work/s1.txt and work/s2.txt already exist.',
        'work/s1.txt must be every input line that contains MARK.',
        `work/s2.txt must be the <id> (second whitespace-separated field) of each s1 line`,
        `whose integer (third field) is greater than ${STAGED_THRESHOLD}, one id per line.`,
        'out.csv must be those ids sorted ascending, one per line, and nothing else.',
      ].join(' '),
      expected: `${hits.join('\n')}\n`,
    });
  }
  return { tasks };
}

export function resetStagedOutput(workDir: string): void {
  fs.rmSync(path.join(workDir, 'work', 's1.txt'), { force: true });
  fs.rmSync(path.join(workDir, 'work', 's2.txt'), { force: true });
  fs.rmSync(path.join(workDir, 'out.csv'), { force: true });
}

function batch(k: number): { body: string; hits: string[] } {
  const lines = [
    `batch ${k}`,
    'filler lines are not part of the answer.',
  ];
  const hits: string[] = [];
  for (let i = 0; i < MARK_ROWS; i += 1) {
    const id = `k${k}i${String(i).padStart(2, '0')}`;
    const n = 100 + ((k * 31 + i * 17) % 800);
    lines.push(`MARK ${id} ${n}`);
    if (n > STAGED_THRESHOLD) hits.push(id);
  }
  lines.push('end of batch');
  hits.sort();
  return { body: `${lines.join('\n')}\n`, hits };
}

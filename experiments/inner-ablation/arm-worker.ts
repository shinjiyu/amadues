/**
 * 消融子进程入口：一次运行 = 一个 arm × 一个任务 × 一次重复。
 * 由 run-ablation.ts 以 `node --import tsx` 拉起，环境变量传参；结果写 .run/ablation-arm-result.json。
 */
import fs from 'node:fs';
import path from 'node:path';

import { runOpenKuronekoPiMonoAuto } from '../../packages/server/src/pi-mono/run-tick.ts';
import { runSingleNodeBaselineInWorkDir } from '../../packages/server/src/pi-mono/run-single-node.ts';
import { ARM_RESULT_FILE } from './arm-worker-paths.ts';

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

async function main(): Promise<void> {
  const arm = need('ABLATION_ARM');
  const workDir = need('INNER_WORK_DIR');
  const workspaceId = need('INNER_WORKSPACE_ID');
  const startedAt = new Date().toISOString();

  let result: Record<string, unknown>;
  if (arm === 'dyflow') {
    const maxTicks = Number(process.env['ABLATION_MAX_TICKS'] ?? 60);
    const r = await runOpenKuronekoPiMonoAuto({ workspaceId, workDir, maxTicks });
    result = { arm, ...r };
  } else if (arm === 'single') {
    const r = await runSingleNodeBaselineInWorkDir({ workspaceId, workDir });
    result = { arm, ...r };
  } else {
    throw new Error(`unknown arm ${arm}`);
  }

  const file = path.join(workDir, ARM_RESULT_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...result, startedAt, finishedAt: new Date().toISOString() }, null, 2));
}

main().then(
  () => process.exit(0),
  e => {
    console.error('[arm-worker] fatal', e);
    process.exit(1);
  },
);

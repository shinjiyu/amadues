/**
 * 一次性脚本：停掉 data-gin 注册表里所有 RUNNING/AWAITING/BLOCKED 内脑。
 * 用法：npx tsx scripts/stop-all-stoppable-ib.ts [dataRoot]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { InnerBrainRegistry } from '../src/outer/inner-brain-registry.js';
import { isInnerBrainStoppable, stopInnerBrainInstance } from '../src/outer/stop-inner-brain.js';

const dataRoot = path.resolve(
  process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data-gin'),
);

const reg = new InnerBrainRegistry(dataRoot);
const targets = reg.list().filter((t) => isInnerBrainStoppable(t.status));

if (!targets.length) {
  console.log(`[stop-all] ${dataRoot}: 无可停实例`);
  process.exit(0);
}

for (const t of targets) {
  const res = stopInnerBrainInstance(t, reg, 'scripts/stop-all-stoppable-ib');
  if (res.ok) {
    console.log(`[stop-all] ${t.instanceId} ${res.priorStatus} → STOPPED (${res.actions.join(', ')})`);
  } else {
    console.log(`[stop-all] ${t.instanceId} skip: ${res.message}`);
  }
}

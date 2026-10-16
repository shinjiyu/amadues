/**
 * 台上等待：工人不退出进程。到点、超时或收到回复后由这名工人继续。
 * ADL: doc/structurizr/WORKSHOP.md §6
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  expireOverduePendings,
  listActivePendings,
  listUnconsumedResolved,
  markConsumed,
  resolveDueTimers,
  type PendingItem,
} from '../pendings/index.js';

const DEFAULT_POLL_MS = 1000;

export interface BenchWaitResult {
  continue: boolean;
  notes: string[];
}

function stopRequested(workDir: string): boolean {
  return fs.existsSync(path.join(workDir, '.stop-signal'));
}

function noteFor(item: PendingItem): string {
  const result =
    item.result === undefined ? '' : ` ${JSON.stringify(item.result).slice(0, 500)}`;
  return `等待结束 ${item.kind} ${item.status}${result}`;
}

export async function waitOnBench(
  workDir: string,
  opts?: { pollMs?: number },
): Promise<BenchWaitResult> {
  const brainDir = path.join(workDir, '.brain');
  const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;
  if (!fs.existsSync(path.join(brainDir, 'pendings.json'))) {
    return { continue: true, notes: [] };
  }

  for (;;) {
    if (stopRequested(workDir)) return { continue: false, notes: [] };
    resolveDueTimers(brainDir);
    expireOverduePendings(brainDir);
    if (listActivePendings(brainDir).length === 0) {
      const done = listUnconsumedResolved(brainDir);
      const notes = done.map(noteFor);
      if (done.length > 0) markConsumed(brainDir, done.map((item) => item.id));
      return { continue: true, notes };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

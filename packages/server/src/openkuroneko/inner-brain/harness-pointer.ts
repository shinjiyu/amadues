/**
 * Harness active pointer — .brain/harness/active.json + history.jsonl
 *
 * ADL: doc/structurizr/HARNESS-RSI.md §3 / §7 (H3–H4)
 */

import fs from 'node:fs';
import path from 'node:path';

import type { HarnessSpecStore } from './harness-spec-store.js';
import { createHarnessSpecStore } from './harness-spec-store.js';
import type { HarnessActivePointer, HarnessHistoryEntry, HarnessStatus } from './harness-types.js';

export interface HarnessPointer {
  readActive(): HarnessActivePointer | null;
  upgrade(harnessId: string): HarnessActivePointer;
  rollback(harnessId: string): HarnessActivePointer;
}

function harnessDir(workDir: string): string {
  return path.join(workDir, '.brain', 'harness');
}

function activePath(workDir: string): string {
  return path.join(harnessDir(workDir), 'active.json');
}

function historyPath(workDir: string): string {
  return path.join(harnessDir(workDir), 'history.jsonl');
}

const ROLLBACK_OK: ReadonlySet<HarnessStatus> = new Set(['gated_ok', 'active', 'superseded']);

function appendHistory(workDir: string, entry: HarnessHistoryEntry): void {
  fs.mkdirSync(harnessDir(workDir), { recursive: true });
  fs.appendFileSync(historyPath(workDir), `${JSON.stringify(entry)}\n`, 'utf8');
}

function writeActive(workDir: string, pointer: HarnessActivePointer): void {
  fs.mkdirSync(harnessDir(workDir), { recursive: true });
  fs.writeFileSync(activePath(workDir), `${JSON.stringify(pointer, null, 2)}\n`, 'utf8');
}

function historicallyActive(workDir: string, harnessId: string): boolean {
  const p = historyPath(workDir);
  if (!fs.existsSync(p)) return false;
  for (const line of fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
    try {
      const e = JSON.parse(line) as HarnessHistoryEntry;
      if ((e.action === 'upgrade' || e.action === 'rollback') && e.to === harnessId) return true;
    } catch {
      /* skip corrupt */
    }
  }
  return false;
}

export function createHarnessPointer(workDir: string, store?: HarnessSpecStore): HarnessPointer {
  const specs = store ?? createHarnessSpecStore(workDir);

  function readActive(): HarnessActivePointer | null {
    const p = activePath(workDir);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8')) as HarnessActivePointer;
  }

  function switchTo(harnessId: string, action: 'upgrade' | 'rollback'): HarnessActivePointer {
    const spec = specs.get(harnessId);
    if (!spec) throw new Error(`[harness-pointer] missing spec ${harnessId}`);
    const prev = readActive();
    if (prev?.harnessId === harnessId) {
      return prev;
    }
    const pointer: HarnessActivePointer = {
      harnessId,
      upgradedAt: new Date().toISOString(),
    };
    if (prev) {
      const old = specs.get(prev.harnessId);
      if (old && old.status === 'active') specs.patchStatus(prev.harnessId, 'superseded');
    }
    specs.patchStatus(harnessId, 'active');
    writeActive(workDir, pointer);
    appendHistory(workDir, {
      ts: pointer.upgradedAt,
      action,
      ...(prev ? { from: prev.harnessId } : {}),
      to: harnessId,
    });
    return pointer;
  }

  return {
    readActive,

    upgrade(harnessId) {
      const spec = specs.get(harnessId);
      if (!spec) throw new Error(`[harness-pointer] missing spec ${harnessId}`);
      if (spec.status !== 'gated_ok' && spec.status !== 'active') {
        throw new Error(
          `[harness-pointer] upgrade requires gated_ok (H3); ${harnessId} is ${spec.status}`,
        );
      }
      return switchTo(harnessId, 'upgrade');
    },

    rollback(harnessId) {
      const spec = specs.get(harnessId);
      if (!spec) throw new Error(`[harness-pointer] missing spec ${harnessId}`);
      const allowed = ROLLBACK_OK.has(spec.status) || historicallyActive(workDir, harnessId);
      if (!allowed) {
        throw new Error(
          `[harness-pointer] rollback target must be gated_ok or historically active (H4); ${harnessId} is ${spec.status}`,
        );
      }
      return switchTo(harnessId, 'rollback');
    },
  };
}

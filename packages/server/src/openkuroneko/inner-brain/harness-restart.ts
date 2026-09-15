/**
 * restart-with-H — flag for controller to re-enter DESIGN under active harness.
 * Not POST /api/inner-brains/:id/restart (process resume). ADL H7.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { HarnessSpecStore } from './harness-spec-store.js';
import { createHarnessPointer } from './harness-pointer.js';

export interface HarnessRestartRequest {
  harnessId: string;
  requestedAt: string;
}

export interface HarnessRestartOpts {
  store?: HarnessSpecStore;
}

function requestPath(workDir: string): string {
  return path.join(workDir, '.brain', 'harness', 'restart-requested.json');
}

export function requestHarnessRestart(
  workDir: string,
  opts: HarnessRestartOpts = {},
): HarnessRestartRequest {
  const active = createHarnessPointer(workDir, opts.store).readActive();
  if (!active) {
    throw new Error('[harness-restart] no active harness (H7 restart-with-H)');
  }
  const req: HarnessRestartRequest = {
    harnessId: active.harnessId,
    requestedAt: new Date().toISOString(),
  };
  const p = requestPath(workDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(req, null, 2)}\n`, 'utf8');
  return req;
}

export function consumeHarnessRestartRequest(workDir: string): HarnessRestartRequest | null {
  const p = requestPath(workDir);
  if (!fs.existsSync(p)) return null;
  try {
    const req = JSON.parse(fs.readFileSync(p, 'utf8')) as HarnessRestartRequest;
    fs.unlinkSync(p);
    if (!req?.harnessId) return null;
    return req;
  } catch {
    try {
      fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
    return null;
  }
}

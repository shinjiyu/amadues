import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '../logger/index.js';
import { createMemoryStore } from './memory-store.js';
import {
  listStallAlertIndex,
  maybeEmitBurstStallAlert,
  readStallAlertBundle,
} from './burst-stall-alert.js';

const tmpRoots: string[] = [];

function mkRoot(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-alert-'));
  tmpRoots.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpRoots) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  tmpRoots.length = 0;
  delete process.env['INNER_BURST_STALL_ALERT'];
  delete process.env['INNER_BURST_STALL_DEBOUNCE_MS'];
});

describe('maybeEmitBurstStallAlert', () => {
  it('writes bundle and index when stalled', () => {
    process.env['INNER_BURST_STALL_ALERT'] = '1';
    process.env['INNER_BURST_STALL_DEBOUNCE_MS'] = '0';

    const dataRoot = mkRoot();
    const workDir = path.join(dataRoot, 'workspaces', 'task-ib-test1');
    fs.mkdirSync(path.join(workDir, '.brain'), { recursive: true });
    const memory = createMemoryStore(workDir);
    memory.recordNodeResult({
      nodeInstId: 'n1',
      ref: 'preset/base',
      ok: false,
      status: 'capped',
      at: new Date().toISOString(),
    });
    memory.recordNodeResult({
      nodeInstId: 'n2',
      ref: 'preset/base',
      ok: false,
      status: 'capped',
      at: new Date().toISOString(),
    });

    const logger = createLogger('task-ib-test1', path.join(workDir, '.run', 'pi-mono'));
    const entry = maybeEmitBurstStallAlert({
      workDir,
      instanceId: 'ib-test1',
      trigger: 'test',
      memory,
      logger,
    });

    expect(entry).not.toBeNull();
    expect(entry!.alertId).toBeTruthy();
    expect(fs.existsSync(entry!.bundlePath)).toBe(true);

    const index = listStallAlertIndex(dataRoot, 10);
    expect(index.some(i => i.alertId === entry!.alertId)).toBe(true);

    const bundle = readStallAlertBundle(dataRoot, entry!.alertId);
    expect(bundle?.verdict.stalled).toBe(true);
    expect(bundle?.cursor.paths.length).toBeGreaterThan(0);
    expect(bundle?.cursor.snippet).toContain('ib-test1');
  });

  it('debounces duplicate signals', () => {
    process.env['INNER_BURST_STALL_ALERT'] = '1';
    process.env['INNER_BURST_STALL_DEBOUNCE_MS'] = '600000';

    const dataRoot = mkRoot();
    const workDir = path.join(dataRoot, 'workspaces', 'task-ib-test2');
    fs.mkdirSync(path.join(workDir, '.brain'), { recursive: true });
    const memory = createMemoryStore(workDir);
    for (const id of ['n1', 'n2']) {
      memory.recordNodeResult({
        nodeInstId: id,
        ref: 'preset/base',
        ok: false,
        status: 'capped',
        at: new Date().toISOString(),
      });
    }
    const logger = createLogger('task-ib-test2', path.join(workDir, '.run', 'pi-mono'));
    const first = maybeEmitBurstStallAlert({
      workDir,
      instanceId: 'ib-test2',
      trigger: 't1',
      memory,
      logger,
    });
    const second = maybeEmitBurstStallAlert({
      workDir,
      instanceId: 'ib-test2',
      trigger: 't2',
      memory,
      logger,
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });
});

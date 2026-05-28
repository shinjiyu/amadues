import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { addPending } from '../openkuroneko/pendings/index.js';
import { InnerBrainRegistry } from './inner-brain-registry.js';
import { isInnerBrainStoppable, stopInnerBrainInstance } from './stop-inner-brain.js';

describe('stop-inner-brain', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const r of roots) {
      fs.rmSync(r, { recursive: true, force: true });
    }
  });

  function mkEnv(status: 'AWAITING' | 'DONE' = 'AWAITING') {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-ib-'));
    roots.push(dataRoot);
    const workDir = path.join(dataRoot, 'ws');
    const brainDir = path.join(workDir, '.brain');
    fs.mkdirSync(brainDir, { recursive: true });
    const registry = new InnerBrainRegistry(dataRoot);
    registry.register({
      instanceId: 'ib-test',
      workspaceId: 'task-ib-test',
      workDir,
      goal: 'test',
      originUser: 'user',
      status,
      startedAt: new Date().toISOString(),
    });
    return { registry, workDir, brainDir };
  }

  it('isInnerBrainStoppable: AWAITING yes, DONE no', () => {
    expect(isInnerBrainStoppable('AWAITING')).toBe(true);
    expect(isInnerBrainStoppable('RUNNING')).toBe(true);
    expect(isInnerBrainStoppable('DONE')).toBe(false);
  });

  it('AWAITING + pending ask_user → STOPPED and pending cancelled', () => {
    const { registry, workDir, brainDir } = mkEnv('AWAITING');
    const record = registry.get('ib-test')!;
    addPending(brainDir, {
      kind: 'ask_user',
      spec: { prompt: 'need password' },
      source: 'test',
    });

    const res = stopInnerBrainInstance(record, registry, 'user abandoned');
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.priorStatus).toBe('AWAITING');
    expect(registry.get('ib-test')?.status).toBe('STOPPED');
    expect(fs.existsSync(path.join(workDir, '.stop-signal'))).toBe(true);

    const pendings = JSON.parse(fs.readFileSync(path.join(brainDir, 'pendings.json'), 'utf8')) as Array<{
      status: string;
    }>;
    expect(pendings[0]?.status).toBe('cancelled');
  });

  it('DONE → ok:false', () => {
    const { registry } = mkEnv('DONE');
    const record = registry.get('ib-test')!;
    const res = stopInnerBrainInstance(record, registry);
    expect(res.ok).toBe(false);
    expect(registry.get('ib-test')?.status).toBe('DONE');
  });
});

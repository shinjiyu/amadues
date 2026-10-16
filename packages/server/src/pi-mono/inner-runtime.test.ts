import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createInnerRuntime } from './inner-runtime.js';

const ENV_KEYS = [
  'HOME',
  'ZHIPU_API_KEY',
  'KIMI_API_KEY',
  'LOCALMODULE_API_KEY',
  'UTLRA_INNER_LLM_PROVIDER',
  'DRIVE9_API_KEY',
  'INNER_KPI_ID',
  'INNER_BURST_ID',
  'INNER_INSTANCE_ID',
] as const;

describe('createInnerRuntime', () => {
  let root = '';
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-runtime-'));
    process.env['HOME'] = path.join(root, 'home');
    fs.mkdirSync(process.env['HOME'], { recursive: true });
    process.env['ZHIPU_API_KEY'] = 'test-key';
    delete process.env['KIMI_API_KEY'];
    delete process.env['LOCALMODULE_API_KEY'];
    delete process.env['UTLRA_INNER_LLM_PROVIDER'];
    delete process.env['DRIVE9_API_KEY'];
    delete process.env['INNER_KPI_ID'];
    delete process.env['INNER_BURST_ID'];
    delete process.env['INNER_INSTANCE_ID'];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('builds the executor tool registry shared by DyFlow and the single-node baseline', () => {
    const workDir = path.join(root, 'workspaces', 'task-ib-abc-1234');
    fs.mkdirSync(workDir, { recursive: true });
    const rt = createInnerRuntime({ workspaceId: 'task-ib-abc-1234', workDir });

    const names = rt.toolRegistry.list().map(t => t.name);
    for (const expected of ['read_file', 'write_file', 'edit_file', 'shell_exec', 'shell_probe', 'web_search', 'register_deliverable']) {
      expect(names).toContain(expected);
    }
    expect(typeof rt.llm.chat).toBe('function');
    expect(fs.existsSync(path.join(workDir, '.run', 'pi-mono', 'agent.config.json'))).toBe(true);
  });

  it('leaves drive9 sharing off when neither env nor CLI config provides a key', () => {
    const workDir = path.join(root, 'ws');
    fs.mkdirSync(workDir, { recursive: true });
    const rt = createInnerRuntime({ workspaceId: 'ws', workDir });
    expect(rt.nodeSharing).toBeUndefined();
    expect(rt.sharedFactSink).toBeUndefined();
  });

  it('derives burstId and instanceId the same way the worker does', () => {
    const workDir = path.join(root, 'workspaces', 'task-ib-xyz-9');
    fs.mkdirSync(workDir, { recursive: true });
    const rt = createInnerRuntime({ workspaceId: 'task-ib-xyz-9', workDir });
    expect(rt.burstId).toBe('task-ib-xyz-9');
    expect(rt.instanceId).toBe('ib-ib-xyz-9');

    process.env['INNER_BURST_ID'] = 'burst-1';
    process.env['INNER_INSTANCE_ID'] = 'ib-explicit';
    const rt2 = createInnerRuntime({ workspaceId: 'task-ib-xyz-9', workDir });
    expect(rt2.burstId).toBe('burst-1');
    expect(rt2.instanceId).toBe('ib-explicit');
  });
});

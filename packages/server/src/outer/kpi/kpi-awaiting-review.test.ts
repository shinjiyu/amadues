import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { addPending } from '../../openkuroneko/pendings/index.js';
import { InnerBrainRegistry } from '../inner-brain-registry.js';
import {
  DEFAULT_ASK_USER_TIMEOUT_MS,
  reviewAwaitingBursts,
} from './kpi-awaiting-review.js';

describe('kpi-awaiting-review', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const r of roots) {
      fs.rmSync(r, { recursive: true, force: true });
    }
  });

  function mkAwaiting(opts: {
    instanceId?: string;
    lastTickAt?: string;
    dyflowMode?: string;
    controllerMode?: string;
    askUser?: boolean;
  } = {}) {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kpi-await-'));
    roots.push(dataRoot);
    const workDir = path.join(dataRoot, 'ws');
    const brainDir = path.join(workDir, '.brain');
    fs.mkdirSync(brainDir, { recursive: true });

    if (opts.dyflowMode) {
      fs.writeFileSync(
        path.join(brainDir, 'dyflow-state.json'),
        JSON.stringify({ mode: opts.dyflowMode }),
        'utf8',
      );
    }
    if (opts.controllerMode) {
      fs.writeFileSync(
        path.join(brainDir, 'controller-state.json'),
        JSON.stringify({ mode: opts.controllerMode }),
        'utf8',
      );
    }
    if (opts.askUser) {
      addPending(brainDir, {
        kind: 'ask_user',
        spec: { prompt: 'need input' },
        source: 'test',
      });
    }

    const registry = new InnerBrainRegistry(dataRoot);
    const instanceId = opts.instanceId ?? 'ib-await';
    registry.register({
      instanceId,
      workspaceId: `task-${instanceId}`,
      workDir,
      goal: 'test',
      originUser: 'user',
      status: 'AWAITING',
      startedAt: opts.lastTickAt ?? new Date().toISOString(),
      lastTickAt: opts.lastTickAt,
    });
    return { registry, dataRoot, instanceId };
  }

  it('R4: ask_user 超时 → stop', async () => {
    const old = new Date(Date.now() - DEFAULT_ASK_USER_TIMEOUT_MS - 60_000).toISOString();
    const { registry, dataRoot, instanceId } = mkAwaiting({
      lastTickAt: old,
      askUser: true,
    });

    const result = await reviewAwaitingBursts(
      { registry, dataRoot },
      { nowMs: Date.now() },
    );

    expect(result.stopped).toEqual([instanceId]);
    expect(result.reasons[instanceId]).toBe('ask_user_timeout');
    expect(registry.get(instanceId)?.status).toBe('STOPPED');
  });

  it('R3: AWAITING 无 pending 且 dyflow AWAITING → stop', async () => {
    const { registry, dataRoot, instanceId } = mkAwaiting({
      dyflowMode: 'AWAITING',
    });

    const result = await reviewAwaitingBursts({ registry, dataRoot });

    expect(result.stopped).toEqual([instanceId]);
    expect(result.reasons[instanceId]).toBe('awaiting_no_pendings');
    expect(registry.get(instanceId)?.status).toBe('STOPPED');
  });

  it('合法 ask_user 未超时 → 不 stop', async () => {
    const { registry, dataRoot, instanceId } = mkAwaiting({
      lastTickAt: new Date().toISOString(),
      askUser: true,
    });

    const result = await reviewAwaitingBursts({ registry, dataRoot });
    expect(result.stopped).toEqual([]);
    expect(registry.get(instanceId)?.status).toBe('AWAITING');
  });

  it('P3: needsReview + LLM 判不合理 → stop', async () => {
    const old = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    const { registry, dataRoot, instanceId } = mkAwaiting({
      lastTickAt: old,
      controllerMode: 'RUNNING',
    });
    addPending(path.join(dataRoot, 'ws', '.brain'), {
      kind: 'timer',
      spec: { execute_at: new Date(Date.now() + 60_000).toISOString() },
      source: 'tool:wait_timer',
    });

    const result = await reviewAwaitingBursts(
      { registry, dataRoot },
      {
        nowMs: Date.now(),
        callLlm: async () => '{"reasonable":false,"reason":"长期无进展"}',
      },
    );

    expect(result.stopped).toEqual([instanceId]);
    expect(result.reasons[instanceId]).toMatch(/^llm_awaiting/);
  });
});

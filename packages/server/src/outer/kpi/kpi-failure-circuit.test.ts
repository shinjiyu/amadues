import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InnerBrainRegistry, type TaskStatus } from '../inner-brain-registry.js';
import { KpiRegistry } from '../kpi-registry.js';
import {
  selectTrippedKpis,
  tripFailureCircuitBreakers,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
} from './kpi-failure-circuit.js';

describe('kpi-failure-circuit (R7)', () => {
  let tmp = '';

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  function setup() {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kpi-fc-'));
    const kpiRegistry = new KpiRegistry(tmp);
    const registry = new InnerBrainRegistry(tmp);
    return { kpiRegistry, registry };
  }

  function addBurst(
    registry: InnerBrainRegistry,
    kpiId: string,
    id: string,
    status: TaskStatus,
    startedAt: string,
    errorMessage?: string,
  ) {
    registry.register({
      instanceId: id,
      workspaceId: `task-${id}`,
      workDir: path.join(tmp, 'workspaces', `task-${id}`),
      goal: 'g',
      originUser: 'idp:agent:kuroneko',
      status,
      startedAt,
      kpiId,
      errorMessage,
    });
  }

  function attach(kpiRegistry: KpiRegistry, kpiId: string, ids: string[]) {
    for (const id of ids) kpiRegistry.attachBurst(kpiId, id);
  }

  it('连续 3 次 ERROR → tripped', () => {
    const { kpiRegistry, registry } = setup();
    const kpi = kpiRegistry.create({ description: '模糊目标', createdBy: 'u', kind: 'ongoing' });
    const t0 = Date.now();
    addBurst(registry, kpi.kpiId, 'ib-1', 'ERROR', new Date(t0).toISOString(), '503 openai_error');
    addBurst(registry, kpi.kpiId, 'ib-2', 'ERROR', new Date(t0 + 1000).toISOString());
    addBurst(registry, kpi.kpiId, 'ib-3', 'ERROR', new Date(t0 + 2000).toISOString());
    attach(kpiRegistry, kpi.kpiId, ['ib-1', 'ib-2', 'ib-3']);

    const tripped = selectTrippedKpis(kpiRegistry, registry, DEFAULT_MAX_CONSECUTIVE_FAILURES);
    expect(tripped.length).toBe(1);
    expect(tripped[0]!.failures).toBe(3);
    expect(tripped[0]!.lastError).toContain('503');
  });

  it('中间有一次 DONE → 连败计数重置，不 tripped', () => {
    const { kpiRegistry, registry } = setup();
    const kpi = kpiRegistry.create({ description: 'x', createdBy: 'u', kind: 'ongoing' });
    const t0 = Date.now();
    addBurst(registry, kpi.kpiId, 'ib-1', 'ERROR', new Date(t0).toISOString());
    addBurst(registry, kpi.kpiId, 'ib-2', 'DONE', new Date(t0 + 1000).toISOString());
    addBurst(registry, kpi.kpiId, 'ib-3', 'ERROR', new Date(t0 + 2000).toISOString());
    addBurst(registry, kpi.kpiId, 'ib-4', 'ERROR', new Date(t0 + 3000).toISOString());
    attach(kpiRegistry, kpi.kpiId, ['ib-1', 'ib-2', 'ib-3', 'ib-4']);

    const tripped = selectTrippedKpis(kpiRegistry, registry, 3);
    expect(tripped.length).toBe(0);
  });

  it('有在跑 burst → 不计熔断', () => {
    const { kpiRegistry, registry } = setup();
    const kpi = kpiRegistry.create({ description: 'x', createdBy: 'u', kind: 'ongoing' });
    const t0 = Date.now();
    addBurst(registry, kpi.kpiId, 'ib-1', 'ERROR', new Date(t0).toISOString());
    addBurst(registry, kpi.kpiId, 'ib-2', 'ERROR', new Date(t0 + 1000).toISOString());
    addBurst(registry, kpi.kpiId, 'ib-3', 'ERROR', new Date(t0 + 2000).toISOString());
    addBurst(registry, kpi.kpiId, 'ib-4', 'RUNNING', new Date(t0 + 3000).toISOString());
    attach(kpiRegistry, kpi.kpiId, ['ib-1', 'ib-2', 'ib-3', 'ib-4']);

    expect(selectTrippedKpis(kpiRegistry, registry, 3).length).toBe(0);
  });

  it('tripFailureCircuitBreakers → pause + 写 pauseReason + IM 通知 + action-log', async () => {
    const { kpiRegistry, registry } = setup();
    const kpi = kpiRegistry.create({ description: '台湾情报常态收集', createdBy: 'u', kind: 'ongoing' });
    const t0 = Date.now();
    addBurst(registry, kpi.kpiId, 'ib-1', 'ERROR', new Date(t0).toISOString(), '503 openai_error');
    addBurst(registry, kpi.kpiId, 'ib-2', 'ERROR', new Date(t0 + 1000).toISOString());
    addBurst(registry, kpi.kpiId, 'ib-3', 'ERROR', new Date(t0 + 2000).toISOString());
    attach(kpiRegistry, kpi.kpiId, ['ib-1', 'ib-2', 'ib-3']);

    const posted: { thread: string; text: string }[] = [];
    const toolCtx = {
      agentSid: 'agent:test',
      imClient: {
        postMessage: async (thread: string, msg: { text: string }) => {
          posted.push({ thread, text: msg.text });
        },
      },
    } as never;

    const res = await tripFailureCircuitBreakers({
      dataRoot: tmp,
      kpiRegistry,
      registry,
      toolCtx,
      defaultThreadId: 'thread-im',
      maxConsecutiveFailures: 3,
    });

    expect(res.tripped.length).toBe(1);
    const updated = kpiRegistry.get(kpi.kpiId);
    expect(updated?.status).toBe('paused');
    expect(updated?.pauseReason).toContain('连续 3 次失败');
    expect(posted.length).toBe(1);
    expect(posted[0]!.text).toContain('已自动暂停');

    const log = fs.readFileSync(path.join(tmp, 'autonomy', 'action-log.jsonl'), 'utf8');
    expect(log).toContain('kpi_failure_circuit');
  });

  it('pause 后 resume 清空 pauseReason', () => {
    const { kpiRegistry } = setup();
    const kpi = kpiRegistry.create({ description: 'x', createdBy: 'u', kind: 'ongoing' });
    kpiRegistry.pause(kpi.kpiId, '连续 3 次失败已熔断');
    expect(kpiRegistry.get(kpi.kpiId)?.status).toBe('paused');
    kpiRegistry.resume(kpi.kpiId);
    expect(kpiRegistry.get(kpi.kpiId)?.status).toBe('active');
    expect(kpiRegistry.get(kpi.kpiId)?.pauseReason).toBeUndefined();
  });
});

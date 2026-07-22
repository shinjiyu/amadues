import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  loadAutonomyPolicy,
  normalizeDigitalEmployeePolicy,
  patchAutonomyPolicy,
  defaultAutonomyPolicy,
} from './autonomy-policy-store.js';
import type { AutonomyPolicy } from '../autonomy-types.js';

describe('autonomy-policy-store DE-4 normalize', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tmpRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-policy-'));
    dirs.push(dir);
    return dir;
  }

  function writeRawPolicy(root: string, raw: unknown): void {
    const dir = path.join(root, 'autonomy');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(raw, null, 2), 'utf8');
  }

  it('默认策略：kpi_inner_goal 只有 enabled，hardGates 无 minMs 字段', () => {
    const policy = defaultAutonomyPolicy();
    expect(policy.taskTypes.kpi_inner_goal).toEqual({ enabled: true });
    expect('minMsSinceLastAutonomousAction' in policy.hardGates).toBe(false);
  });

  it('load 删除旧 kpi_inner_goal 配额字段与 minMs，并回写磁盘', () => {
    const root = tmpRoot();
    writeRawPolicy(root, {
      version: 1,
      enabled: true,
      hardGates: {
        maxRunningInnerBrains: 3,
        maxAwaitingInnerBrains: 3,
        maxParallelBurstsPerKpi: 1,
        maxLlmInFlight: 2,
        maxTokensPerHour: null,
        minMsSinceLastAutonomousAction: 900_000,
        blockIfOrchestratorQueuedAbove: 2,
        blockIfOuterLoopActive: true,
      },
      taskTypes: {
        casual_chat: { enabled: true, cooldownMs: 3_600_000, maxPerDay: 8 },
        kpi_inner_goal: { enabled: true, cooldownMs: 7_200_000, maxPerDay: 3 },
      },
      lastAutonomousActionAt: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
      updatedBy: 'system',
    });

    const loaded = loadAutonomyPolicy(root);
    expect(loaded.taskTypes.kpi_inner_goal).toEqual({ enabled: true });
    expect('minMsSinceLastAutonomousAction' in loaded.hardGates).toBe(false);
    // casual_chat 频控保留
    expect(loaded.taskTypes.casual_chat?.maxPerDay).toBe(8);
    expect(loaded.taskTypes.casual_chat?.cooldownMs).toBe(3_600_000);

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(root, 'autonomy', 'policy.json'), 'utf8'),
    ) as AutonomyPolicy;
    expect(onDisk.taskTypes.kpi_inner_goal).toEqual({ enabled: true });
    expect('minMsSinceLastAutonomousAction' in onDisk.hardGates).toBe(false);
  });

  it('patch 写入旧配额字段也会被删除', () => {
    const root = tmpRoot();
    const next = patchAutonomyPolicy(root, {
      taskTypes: {
        kpi_inner_goal: { enabled: true, cooldownMs: 3_600_000, maxPerDay: 3 },
      },
    });
    expect(next.taskTypes.kpi_inner_goal).toEqual({ enabled: true });
  });

  it('normalizeDigitalEmployeePolicy 幂等', () => {
    const base = defaultAutonomyPolicy();
    const dirty: AutonomyPolicy = {
      ...base,
      taskTypes: {
        ...base.taskTypes,
        kpi_inner_goal: { enabled: false, cooldownMs: 1, maxPerDay: 1 },
      },
    };
    const first = normalizeDigitalEmployeePolicy(dirty);
    expect(first.changed).toBe(true);
    expect(first.policy.taskTypes.kpi_inner_goal).toEqual({ enabled: false });
    const second = normalizeDigitalEmployeePolicy(first.policy);
    expect(second.changed).toBe(false);
  });
});

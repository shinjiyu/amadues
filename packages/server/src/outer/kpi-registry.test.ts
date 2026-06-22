/**
 * KpiRegistry 单元测试
 *
 * 守住三条核心契约：
 *   1. create / get / list / list(filter) 基本 CRUD
 *   2. idleStreak 的增 / 重置 / 持久化
 *   3. burstRunHistory 追加 + 跨实例往返
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  KpiRegistry,
  MOMENTUM_MAX,
  MOMENTUM_MIN,
  type BurstRunRecord,
} from './kpi-registry.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kuroneko-kpi-'));
});

afterEach(() => {
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

describe('KpiRegistry.create / get / list', () => {
  it('生成的 KPI 有合法 ID、active 状态、初始 0 streak、空 history', () => {
    const reg = new KpiRegistry(tmpRoot);
    const k = reg.create({ description: '查到 X 的手机号', createdBy: 'user:alice' });

    expect(k.kpiId).toMatch(/^kpi-/);
    expect(k.status).toBe('active');
    expect(k.consecutiveIdleBursts).toBe(0);
    expect(k.burstRunHistory).toEqual([]);
    expect(k.bursts).toEqual([]);
    expect(k.description).toBe('查到 X 的手机号');

    const fetched = reg.get(k.kpiId);
    expect(fetched).toBeDefined();
    expect(fetched?.description).toBe('查到 X 的手机号');
  });

  it('list 按创建时间倒序，并支持 status 过滤', async () => {
    const reg = new KpiRegistry(tmpRoot);
    const k1 = reg.create({ description: 'A', createdBy: 'u' });
    await new Promise((r) => setTimeout(r, 5));
    const k2 = reg.create({ description: 'B', createdBy: 'u' });
    reg.pause(k1.kpiId);

    const all = reg.list();
    expect(all.map((k) => k.kpiId)).toEqual([k2.kpiId, k1.kpiId]);

    const active = reg.list({ status: 'active' });
    expect(active).toHaveLength(1);
    expect(active[0]?.kpiId).toBe(k2.kpiId);
  });
});

describe('KpiRegistry idle streak', () => {
  it('recordIdle 递增，resetIdle 归零', () => {
    const reg = new KpiRegistry(tmpRoot);
    const k = reg.create({ description: '...', createdBy: 'u' });
    expect(reg.recordIdle(k.kpiId)).toBe(1);
    expect(reg.recordIdle(k.kpiId)).toBe(2);
    reg.resetIdle(k.kpiId);
    expect(reg.get(k.kpiId)?.consecutiveIdleBursts).toBe(0);
  });

  it('对不存在的 KPI 调用是安全的（不抛、不写）', () => {
    const reg = new KpiRegistry(tmpRoot);
    expect(reg.recordIdle('nope')).toBe(0);
    expect(() => reg.resetIdle('nope')).not.toThrow();
  });
});

describe('KpiRegistry.appendBurstRun', () => {
  it('追加 burstRunHistory 并可读取', () => {
    const reg = new KpiRegistry(tmpRoot);
    const k = reg.create({ description: '...', createdBy: 'u' });
    const run: BurstRunRecord = {
      runId: 'run-1',
      instanceId: 'ib-1',
      kpiId: k.kpiId,
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T01:00:00.000Z',
      exitStatus: 'DONE',
      charter: 'c',
      ticks: 2,
      deliverableCount: 1,
    };
    reg.appendBurstRun(k.kpiId, run);
    expect(reg.get(k.kpiId)?.burstRunHistory).toHaveLength(1);
    expect(reg.get(k.kpiId)?.burstRunHistory[0]?.instanceId).toBe('ib-1');
  });
});

describe('KpiRegistry 持久化', () => {
  it('跨实例往返：history / idleStreak / status / bursts 都保留；未知字段丢弃', () => {
    const reg1 = new KpiRegistry(tmpRoot);
    const k = reg1.create({ description: '长目标', createdBy: 'u', notes: '不要付费' });
    reg1.attachBurst(k.kpiId, 'b-001');
    reg1.attachBurst(k.kpiId, 'b-002');
    reg1.recordIdle(k.kpiId);
    reg1.recordIdle(k.kpiId);
    reg1.appendBurstRun(k.kpiId, {
      runId: 'run-1',
      instanceId: 'b-001',
      kpiId: k.kpiId,
      startedAt: '2025-01-01T00:00:00.000Z',
      finishedAt: '2025-01-01T01:00:00.000Z',
      exitStatus: 'DONE',
      charter: 'c',
      ticks: 1,
      deliverableCount: 0,
      outcomeEvaluation: {
        evaluatedAt: '2025-01-01T01:00:00.000Z',
        successConfirmed: false,
        confidence: 'high',
        failureReasons: ['公开 API 拒绝'],
        evidenceSummary: 'fail',
        processReportDigest: '',
      },
    });

    const raw = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'kpi-registry.json'), 'utf8')) as Array<
      Record<string, unknown>
    >;
    raw[0]!['_unknownLegacy'] = [{ verdict: 'failed' }];
    fs.writeFileSync(path.join(tmpRoot, 'kpi-registry.json'), JSON.stringify(raw), 'utf8');

    const reg2 = new KpiRegistry(tmpRoot);
    const fetched = reg2.get(k.kpiId);
    expect(fetched).toBeDefined();
    expect(fetched?.description).toBe('长目标');
    expect(fetched?.notes).toBe('不要付费');
    expect(fetched?.bursts).toEqual(['b-001', 'b-002']);
    expect(fetched?.consecutiveIdleBursts).toBe(2);
    expect(fetched?.burstRunHistory).toHaveLength(1);
    expect(fetched?.burstRunHistory[0]?.outcomeEvaluation?.failureReasons).toEqual(['公开 API 拒绝']);
    expect('_unknownLegacy' in (fetched as object)).toBe(false);
  });

  it('attachBurst 去重（同一 instanceId 重复 attach 不会双倍）', () => {
    const reg = new KpiRegistry(tmpRoot);
    const k = reg.create({ description: '...', createdBy: 'u' });
    reg.attachBurst(k.kpiId, 'b-1');
    reg.attachBurst(k.kpiId, 'b-1');
    reg.attachBurst(k.kpiId, 'b-1');
    expect(reg.get(k.kpiId)?.bursts).toEqual(['b-1']);
  });
});

describe('KpiRegistry momentum', () => {
  it('adjustMomentum clamp 在 [MOMENTUM_MIN, MOMENTUM_MAX]', () => {
    const reg = new KpiRegistry(tmpRoot);
    const k = reg.create({ description: '...', createdBy: 'u' });
    for (let i = 0; i < 20; i++) reg.adjustMomentum(k.kpiId, 1);
    expect(reg.get(k.kpiId)?.momentum).toBe(MOMENTUM_MAX);
    for (let i = 0; i < 20; i++) reg.adjustMomentum(k.kpiId, -1);
    expect(reg.get(k.kpiId)?.momentum).toBe(MOMENTUM_MIN);
  });
});

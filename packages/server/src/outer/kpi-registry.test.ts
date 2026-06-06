/**
 * KpiRegistry 单元测试
 *
 * 守住三条核心契约：
 *   1. create / get / list / list(filter) 基本 CRUD
 *   2. idleStreak 的增 / 重置 / 持久化
 *   3. reflexionTrail 追加 + 跨实例往返（防回归：之前的 inner-brain-registry 写过类似 bug）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  KpiRegistry,
  MOMENTUM_MAX,
  MOMENTUM_MIN,
  type ReflexionSummary,
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
  it('生成的 KPI 有合法 ID、active 状态、初始 0 streak、空 trail', () => {
    const reg = new KpiRegistry(tmpRoot);
    const k = reg.create({ description: '查到 X 的手机号', createdBy: 'user:alice' });

    expect(k.kpiId).toMatch(/^kpi-/);
    expect(k.status).toBe('active');
    expect(k.consecutiveIdleBursts).toBe(0);
    expect(k.reflexionTrail).toEqual([]);
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
    await new Promise((r) => setTimeout(r, 5));
    const k3 = reg.create({ description: 'C', createdBy: 'u' });

    reg.abandon(k2.kpiId, '不可达');

    const all = reg.list();
    expect(all.map((k) => k.kpiId)).toEqual([k3.kpiId, k2.kpiId, k1.kpiId]);

    const active = reg.list({ status: 'active' });
    expect(active.map((k) => k.kpiId)).toEqual([k3.kpiId, k1.kpiId]);

    const abandoned = reg.list({ status: 'abandoned' });
    expect(abandoned.map((k) => k.kpiId)).toEqual([k2.kpiId]);
  });
});

describe('KpiRegistry.kind (delivery / ongoing)', () => {
  it('默认 kind=delivery、momentum=0', () => {
    const reg = new KpiRegistry(tmpRoot);
    const k = reg.create({ description: '一次性目标', createdBy: 'u' });
    expect(k.kind).toBe('delivery');
    expect(k.momentum).toBe(0);
  });

  it('create 可指定 kind=ongoing 并持久化', () => {
    const reg1 = new KpiRegistry(tmpRoot);
    const k = reg1.create({ description: '24h 情报常驻', createdBy: 'u', kind: 'ongoing' });
    expect(k.kind).toBe('ongoing');

    const reg2 = new KpiRegistry(tmpRoot);
    expect(reg2.get(k.kpiId)?.kind).toBe('ongoing');
  });
});

describe('KpiRegistry.adjustMomentum (多巴胺反馈调节)', () => {
  it('正/负增量累加并返回更新值', () => {
    const reg = new KpiRegistry(tmpRoot);
    const k = reg.create({ description: '...', createdBy: 'u' });
    expect(reg.adjustMomentum(k.kpiId, 2)).toBe(2);
    expect(reg.adjustMomentum(k.kpiId, 1)).toBe(3);
    expect(reg.adjustMomentum(k.kpiId, -2)).toBe(1);
  });

  it('clamp 在 [MOMENTUM_MIN, MOMENTUM_MAX]', () => {
    const reg = new KpiRegistry(tmpRoot);
    const k = reg.create({ description: '...', createdBy: 'u' });
    reg.adjustMomentum(k.kpiId, 100);
    expect(reg.get(k.kpiId)?.momentum).toBe(MOMENTUM_MAX);
    reg.adjustMomentum(k.kpiId, -100);
    expect(reg.get(k.kpiId)?.momentum).toBe(MOMENTUM_MIN);
  });

  it('delta=0 或 KPI 不存在时安全', () => {
    const reg = new KpiRegistry(tmpRoot);
    const k = reg.create({ description: '...', createdBy: 'u' });
    expect(reg.adjustMomentum(k.kpiId, 0)).toBe(0);
    expect(reg.adjustMomentum('nope', 5)).toBe(0);
  });

  it('momentum 跨实例持久化', () => {
    const reg1 = new KpiRegistry(tmpRoot);
    const k = reg1.create({ description: '...', createdBy: 'u' });
    reg1.adjustMomentum(k.kpiId, 3);
    const reg2 = new KpiRegistry(tmpRoot);
    expect(reg2.get(k.kpiId)?.momentum).toBe(3);
  });
});

describe('KpiRegistry.recordIdle / resetIdle', () => {
  it('recordIdle 递增并返回当前 streak；resetIdle 归零', () => {
    const reg = new KpiRegistry(tmpRoot);
    const k = reg.create({ description: '...', createdBy: 'u' });

    expect(reg.recordIdle(k.kpiId)).toBe(1);
    expect(reg.recordIdle(k.kpiId)).toBe(2);
    expect(reg.recordIdle(k.kpiId)).toBe(3);

    reg.resetIdle(k.kpiId);
    expect(reg.get(k.kpiId)?.consecutiveIdleBursts).toBe(0);

    // resetIdle 应是幂等的，重复调用不该爆
    reg.resetIdle(k.kpiId);
    expect(reg.get(k.kpiId)?.consecutiveIdleBursts).toBe(0);
  });

  it('对不存在的 KPI 调用是安全的（不抛、不写）', () => {
    const reg = new KpiRegistry(tmpRoot);
    expect(reg.recordIdle('nope')).toBe(0);
    expect(() => reg.resetIdle('nope')).not.toThrow();
  });
});

describe('KpiRegistry.appendReflexion / recentReflexions', () => {
  function makeRef(verdict: 'success' | 'partial' | 'failed', id: string): ReflexionSummary {
    return {
      ts: new Date().toISOString(),
      burstInstanceId: id,
      verdict,
      hardFailures: verdict === 'failed' ? ['X 路径死了'] : [],
      softFailures: [],
      nextStrategy: verdict === 'failed' ? '试试 Y 路径' : '',
    };
  }

  it('追加 + recentReflexions 倒序返回最近 N 条', () => {
    const reg = new KpiRegistry(tmpRoot);
    const k = reg.create({ description: '...', createdBy: 'u' });
    reg.appendReflexion(k.kpiId, makeRef('failed', 'b1'));
    reg.appendReflexion(k.kpiId, makeRef('failed', 'b2'));
    reg.appendReflexion(k.kpiId, makeRef('partial', 'b3'));
    reg.appendReflexion(k.kpiId, makeRef('success', 'b4'));

    const recent = reg.recentReflexions(k.kpiId, 3);
    expect(recent.map((r) => r.burstInstanceId)).toEqual(['b4', 'b3', 'b2']);
  });
});

describe('KpiRegistry 持久化', () => {
  it('跨实例往返：trail / idleStreak / status / bursts 都保留', () => {
    const reg1 = new KpiRegistry(tmpRoot);
    const k = reg1.create({ description: '长目标', createdBy: 'u', notes: '不要付费' });
    reg1.attachBurst(k.kpiId, 'b-001');
    reg1.attachBurst(k.kpiId, 'b-002');
    reg1.recordIdle(k.kpiId);
    reg1.recordIdle(k.kpiId);
    reg1.appendReflexion(k.kpiId, {
      ts: '2025-01-01T00:00:00.000Z',
      burstInstanceId: 'b-001',
      verdict: 'failed',
      hardFailures: ['公开 API 拒绝'],
      softFailures: ['关键词搜索命中率低'],
      nextStrategy: '换社工方向',
    });

    const reg2 = new KpiRegistry(tmpRoot);
    const fetched = reg2.get(k.kpiId);
    expect(fetched).toBeDefined();
    expect(fetched?.description).toBe('长目标');
    expect(fetched?.notes).toBe('不要付费');
    expect(fetched?.bursts).toEqual(['b-001', 'b-002']);
    expect(fetched?.consecutiveIdleBursts).toBe(2);
    expect(fetched?.reflexionTrail).toHaveLength(1);
    expect(fetched?.reflexionTrail[0]?.hardFailures).toEqual(['公开 API 拒绝']);
    expect(fetched?.reflexionTrail[0]?.nextStrategy).toBe('换社工方向');
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

describe('KpiRegistry 终态：abandon / achieve / pause / resume', () => {
  it('abandon 设状态 + 落 finalizedAt/reason', () => {
    const reg = new KpiRegistry(tmpRoot);
    const k = reg.create({ description: '...', createdBy: 'u' });
    reg.abandon(k.kpiId, '所有路都死了');
    const after = reg.get(k.kpiId);
    expect(after?.status).toBe('abandoned');
    expect(after?.finalizedAt).toBeTruthy();
    expect(after?.finalizedReason).toBe('所有路都死了');
  });

  it('markAchieved 设状态 + 落 evidence', () => {
    const reg = new KpiRegistry(tmpRoot);
    const k = reg.create({ description: '...', createdBy: 'u' });
    reg.markAchieved(k.kpiId, '已拿到 X');
    expect(reg.get(k.kpiId)?.status).toBe('achieved');
    expect(reg.get(k.kpiId)?.finalizedReason).toBe('已拿到 X');
  });

  it('pause/resume：resume 仅对 paused 生效，achieved/abandoned 不能复活', () => {
    const reg = new KpiRegistry(tmpRoot);
    const k1 = reg.create({ description: '...', createdBy: 'u' });
    reg.pause(k1.kpiId);
    expect(reg.get(k1.kpiId)?.status).toBe('paused');
    reg.resume(k1.kpiId);
    expect(reg.get(k1.kpiId)?.status).toBe('active');

    const k2 = reg.create({ description: '...', createdBy: 'u' });
    reg.abandon(k2.kpiId);
    reg.resume(k2.kpiId); // 不应改回 active
    expect(reg.get(k2.kpiId)?.status).toBe('abandoned');
  });
});

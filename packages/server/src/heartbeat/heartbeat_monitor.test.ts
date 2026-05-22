/**
 * heartbeat_monitor 单元测试
 *
 * 覆盖设计文档 6. 测试场景：
 * - born 事件：写入 born → 正常启动；无 born → 直接死亡
 * - N=3 死锁检测：连续 3 次无变化 → 判定死亡
 * - 正常存活：持续产生日志 → 始终存活
 * - 防伪造：环境侧持有写入权限
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  InMemoryActionLogStore,
  LogStoreSnapshotProvider,
  HeartbeatMonitor,
  HeartbeatStatus,
  BORN_OPERATION_TYPE,
} from './index.js';
import type { ActionLogEntry } from './types.js';

// ─── 测试辅助函数 ──────────────────────────────────────────

function makeBornEntry(agentId: string, ts: number = Date.now()): ActionLogEntry {
  return {
    timestamp: ts,
    operation_type: BORN_OPERATION_TYPE,
    impact_scope: `agent:${agentId}`,
  };
}

function makeActionEntry(
  type: string = 'file_write',
  scope: string = 'workspace:test/file:test.ts',
  ts: number = Date.now(),
): ActionLogEntry {
  return {
    timestamp: ts,
    operation_type: type,
    impact_scope: scope,
  };
}

function createMonitor(agentId: string, opts?: { checkIntervalMs?: number; deathThreshold?: number }) {
  const logStore = new InMemoryActionLogStore();
  const snapshotProvider = new LogStoreSnapshotProvider(logStore);
  const monitor = new HeartbeatMonitor(
    {
      agentId,
      checkIntervalMs: opts?.checkIntervalMs ?? 100,
      deathThreshold: opts?.deathThreshold ?? 3,
    },
    logStore,
    snapshotProvider,
  );
  return { logStore, snapshotProvider, monitor };
}

// ─── 测试套件 ───────────────────────────────────────────────

describe('InMemoryActionLogStore', () => {
  let store: InMemoryActionLogStore;

  beforeEach(() => {
    store = new InMemoryActionLogStore();
  });

  it('应能追加并读取行为日志条目', async () => {
    const entry = makeBornEntry('agent-1');
    await store.append('agent-1', entry);

    const logs = await store.read('agent-1');
    expect(logs).toHaveLength(1);
    expect(logs[0].operation_type).toBe(BORN_OPERATION_TYPE);
  });

  it('应能写入 born 事件', async () => {
    const born = makeBornEntry('agent-1', 1000);
    await store.append('agent-1', born);

    const count = await store.count('agent-1');
    expect(count).toBe(1);

    const logs = await store.read('agent-1');
    expect(logs[0].operation_type).toBe('born');
    expect(logs[0].impact_scope).toBe('agent:agent-1');
  });

  it('应能追加多条日志并保持顺序', async () => {
    await store.append('agent-1', makeBornEntry('agent-1', 1000));
    await store.append('agent-1', makeActionEntry('file_write', 'file:a.ts', 2000));
    await store.append('agent-1', makeActionEntry('api_call', 'api:llm', 3000));

    const logs = await store.read('agent-1');
    expect(logs).toHaveLength(3);
    expect(logs[0].timestamp).toBeLessThanOrEqual(logs[1].timestamp);
    expect(logs[1].timestamp).toBeLessThanOrEqual(logs[2].timestamp);
  });

  it('count 应返回正确条目数', async () => {
    expect(await store.count('agent-1')).toBe(0);
    await store.append('agent-1', makeBornEntry('agent-1'));
    expect(await store.count('agent-1')).toBe(1);
  });

  it('clear 应清除所有日志', async () => {
    await store.append('agent-1', makeBornEntry('agent-1'));
    await store.clear('agent-1');
    expect(await store.count('agent-1')).toBe(0);
  });

  it('不同 agent 的日志应互相隔离', async () => {
    await store.append('agent-1', makeBornEntry('agent-1'));
    await store.append('agent-2', makeBornEntry('agent-2'));

    expect(await store.count('agent-1')).toBe(1);
    expect(await store.count('agent-2')).toBe(1);

    await store.clear('agent-1');
    expect(await store.count('agent-1')).toBe(0);
    expect(await store.count('agent-2')).toBe(1);
  });
});

describe('LogStoreSnapshotProvider', () => {
  it('应从日志存储生成快照', async () => {
    const logStore = new InMemoryActionLogStore();
    const provider = new LogStoreSnapshotProvider(logStore);

    await logStore.append('agent-1', makeBornEntry('agent-1'));

    const snapshot = await provider.capture('agent-1');
    expect(snapshot.agentId).toBe('agent-1');
    expect(snapshot.logEntries).toHaveLength(1);
    expect(snapshot.capturedAt).toBeGreaterThan(0);
  });

  it('空日志应生成空快照', async () => {
    const logStore = new InMemoryActionLogStore();
    const provider = new LogStoreSnapshotProvider(logStore);

    const snapshot = await provider.capture('agent-1');
    expect(snapshot.logEntries).toHaveLength(0);
  });
});

describe('HeartbeatMonitor — born 事件', () => {
  it('有 born 事件时应正常存活', async () => {
    const { logStore, monitor } = createMonitor('agent-1', { deathThreshold: 3 });

    let aliveCount = 0;
    monitor.onAlive(() => { aliveCount++; });

    // 写入 born
    await logStore.append('agent-1', makeBornEntry('agent-1'));
    await monitor.tick();

    expect(monitor.getStatus()).toBe(HeartbeatStatus.Alive);
    expect(aliveCount).toBeGreaterThanOrEqual(1);
  });

  it('无 born 事件时应直接判定死亡', async () => {
    const { monitor } = createMonitor('agent-1', { deathThreshold: 3 });

    let died = false;
    monitor.onDeath(() => { died = true; });

    // 不写入 born，直接检测
    await monitor.tick();

    expect(monitor.getStatus()).toBe(HeartbeatStatus.Dead);
    expect(died).toBe(true);
    expect(monitor.getNoChangeCount()).toBeGreaterThanOrEqual(3);
  });

  it('初始状态应为 WaitingForBorn', async () => {
    const { monitor } = createMonitor('agent-1');
    expect(monitor.getStatus()).toBe(HeartbeatStatus.WaitingForBorn);
  });
});

describe('HeartbeatMonitor — N=3 死锁检测', () => {
  it('连续 3 次无变化应判定死亡', async () => {
    const { logStore, monitor } = createMonitor('agent-1', { deathThreshold: 3 });

    let died = false;
    let deathResult: any = null;
    monitor.onDeath((_agentId, result) => {
      died = true;
      deathResult = result;
    });

    // 写入 born
    await logStore.append('agent-1', makeBornEntry('agent-1'));
    await monitor.tick();
    expect(monitor.getStatus()).toBe(HeartbeatStatus.Alive);

    // 连续  présence 次无变化
    await monitor.tick(); // noChangeCount = 1
    expect(monitor.getStatus()).toBe(HeartbeatStatus.Alive);

    await monitor.tick(); // noChangeCount = 2
    expect(monitor.getStatus()).toBe(HeartbeatStatus.Alive);

    await monitor.tick(); // noChangeCount = 3 → death
    expect(monitor.getStatus()).toBe(HeartbeatStatus.Dead);
    expect(died).toBe(true);
    expect(deathResult).toBeDefined();
    expect(deathResult.noChangeCount).toBeGreaterThanOrEqual(3);
  });

  it('连续只有 2 次无变化不应死亡', async () => {
    const { logStore, monitor } = createMonitor('agent-1', { deathThreshold: 3 });

    let died = false;
    monitor.onDeath(() => { died = true; });

    await logStore.append('agent-1', makeBornEntry('agent-1'));
    await monitor.tick(); // born → alive
    await monitor.tick(); // 1
    await monitor.tick(); // 2

    expect(monitor.getStatus()).toBe(HeartbeatStatus.Alive);
    expect(died).toBe(false);
  });

  it('有变化后应重置计数', async () => {
    const { logStore, monitor } = createMonitor('agent-1', { deathThreshold: 3 });

    let died = false;
    monitor.onDeath(() => { died = true; });

    // born
    await logStore.append('agent-1', makeBornEntry('agent-1'));
    await monitor.tick(); // alive
    expect(monitor.getNoChangeCount()).toBe(0);

    // 2 次无变化
    await monitor.tick(); // count=1
    await monitor.tick(); // count= поха 2
    expect(monitor.getNoChangeCount()).toBe(2);

    // 写入新日志，有变化
    await logStore.append('agent-1', makeActionEntry());
    await monitor.tick(); // 检测到变化，重置计数

    expect(monitor.getStatus()).toBe(HeartbeatStatus.Alive);
    expect(monitor.getNoChangeCount()).toBe(0);
    expect(died).toBe(false);
  });

  it('变化检测应基于日志条目数增加', async () => {
    const { logStore, monitor } = createMonitor('agent-1', { deathThreshold: 3 });

    let aliveCalls = 0;
    monitor.onAlive(() => { aliveCalls++; });

    // born
    await logStore.append('agent-1', makeBornEntry('agent-1'));
    await monitor.tick();

    // 无变化一次
    await monitor.tick();
    const aliveBeforeAction = aliveCalls;

    // 写入新日志
    await logStore.append('agent-1', makeActionEntry());
    await monitor.tick(); // 有变化

    // 应触发 alive 回调
    expect(aliveCalls).toBeGreaterThan(aliveBeforeAction);
  });
});

describe('HeartbeatMonitor — 正常存活', () => {
  it('持续产生日志应一直存活', async () => {
    const { logStore, monitor } = createMonitor('agent-1', { deathThreshold: 3 });

    let died = false;
    monitor.onDeath(() => { died = true; });

    await logStore.append('agent-1', makeBornEntry('agent-1'));
    await monitor.tick();
    expect(monitor.getStatus()).toBe(HeartbeatStatus.Alive);

    // 持续产生日志，每次 tick 前写入一条
    for (let i = 0; i < 10; i++) {
      await logStore.append('agent-1', makeActionEntry('file_write', `file:${i}.ts`, Date.now()));
      await monitor.tick();
    }

    expect(monitor.getStatus()).toBe(HeartbeatStatus.Alive);
    expect(died).toBe(false);
    expect(monitor.getNoChangeCount()).toBe(0);
  });
});

describe('HeartbeatMonitor — 回调机制', () => {
  it('onAlive 应在每次存活时触发', async () => {
    const { logStore, monitor } = createMonitor('agent-1');

    const aliveLog: Array<{ noChangeCount: number; hasChange: boolean }> = [];
    monitor.onAlive((_aid, result) => {
      aliveLog.push({ noChangeCount: result.noChangeCount, hasChange: result.hasChange });
    });

    await logStore.append('agent-1', makeBornEntry('agent-1'));
    await monitor.tick(); // born → alive (hasChange=true)

    await monitor.tick(); // 无变化 alive (hasChange=false)
    await monitor.tick(); // 无变化 alive (hasChange=false)

    expect(aliveLog.length).toBeGreaterThanOrEqual(2);
  });

  it('onDeath 只应触发一次', async () => {
    const { logStore, monitor } = createMonitor('agent-1', { deathThreshold: 2 });

    let deathCount = 0;
    monitor.onDeath(() => { deathCount++; });

    await logStore.append('agent-1', makeBornEntry('agent-1'));
    await monitor.tick(); // born → alive
    await monitor.tick(); // no change 1
    await monitor.tick(); // no change 2 → death

    expect(deathCount).toBe(1);
    expect(monitor.getStatus()).toBe(HeartbeatStatus.Dead);

    // 死亡后 tick 不应再触发
    await monitor.tick();
    expect(deathCount).toBe(1);
  });
});

describe('HeartbeatMonitor — 不同 deathThreshold', () => {
  it('N=1 时一次无变化就死亡', async () => {
    const { logStore, monitor } = createMonitor('agent-1', { deathThreshold: 1 });

    let died = false;
    monitor.onDeath(() => { died = true; });

    await logStore.append('agent-1', makeBornEntry('agent-1'));
    await monitor.tick(); // born → alive
    await monitor.tick(); // 1 次无变化 → death

    expect(died).toBe(true);
    expect(monitor.getStatus()).toBe(HeartbeatStatus.Dead);
  });

  it('N=5 时需要 5 次无变化才死亡', async () => {
    const { logStore, monitor } = createMonitor('agent-1', { deathThreshold: 5 });

    let aliveAtFour = false;
    let diedAtFive = false;

    await logStore.append('agent-1', makeBornEntry('agent-1'));
    await monitor.tick(); // born → alive

    // 逐次 tick，记录状态
    for (let i = 0; i < 4; i++) {
      await monitor.tick();
    }
    aliveAtFour = monitor.getStatus() === HeartbeatStatus.Alive;

    await monitor.tick(); // 第 5 次 — 应死亡
    diedAtFive = monitor.getStatus() === HeartbeatStatus.Dead;

    expect(aliveAtFour).toBe(true);
    expect(diedAtFive).toBe(true);
  });
});

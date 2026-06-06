/**
 * ChangeWatcher — 数据驱动的 agent 引擎
 *
 * 设计文档：doc/agent-data-state-machine.md §6
 *
 * 职责：
 *   1. TimerWatcher：监听每个 AWAITING workspace 的 pendings.json，
 *      其中 timer kind 的 execute_at 到点时把 pending 改 resolved。
 *   2. DeadlineWatcher：同上，处理 deadline 超时（按 on_timeout 策略）。
 *   3. ResolutionWatcher：检测到 pendings 中有 unconsumed resolved 时，
 *      spawn 一段新的 burst（worker 子进程），让 agent 处理这些 resolved。
 *
 * 实现方式（v1，简单稳健）：
 *   - 单个 setInterval 每 1s 扫一次所有 AWAITING 任务的 pendings.json
 *   - 不用最小堆 setTimeout（简化实现；后续可优化）
 *   - 文件锁：spawn 之前检查 task.pid 是否还活着，避免重复 spawn
 *
 * 由外脑 server 启动时 start()，进程退出时 stop()。
 */

import fs from 'node:fs';
import path from 'node:path';

import type { InnerBrainRegistry, TaskRecord } from '../outer/inner-brain-registry.js';
import {
  resolveDueTimers,
  expireOverduePendings,
  listActivePendings,
  listUnconsumedResolved,
  findByCtxRef,
  resolvePending,
  markConsumed,
  type PendingItem,
} from '../openkuroneko/pendings/index.js';
import { isPidAlive } from './inner-brain-spawner.js';

// ── 配置 ──────────────────────────────────────────────────────────────────────

const DEFAULT_POLL_MS = 1000;
/** AWAITING burst 默认 maxTicks（不需要太大，醒来跑几步就好） */
const AWAKE_BURST_MAX_TICKS = 50;

// ── 类型 ──────────────────────────────────────────────────────────────────────

export interface ChangeWatcherOptions {
  registry: InnerBrainRegistry;
  pollMs?: number;
  /**
   * spawn 一段新的 burst：由调用方注入,确保 onExit 走 KPI hook、
   * deliverable / reflexion 处理等完整链路。
   * 返回 { ok: true } 即可,失败时 ChangeWatcher 会清理 inFlight 标记。
   */
  spawnTask: (task: TaskRecord) => { ok: boolean; error?: string };
  /** 启动 bootstrap 时调用（registryLifecycleReconcile）；P0 见 INNER-BRAIN-AWAITING-LIFECYCLE */
  reconcileOnBootstrap?: () => void;
}

// ── ChangeWatcher 主类 ────────────────────────────────────────────────────────

export class ChangeWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly inFlightWakeups: Set<string> = new Set();

  constructor(private readonly opts: ChangeWatcherOptions) {}

  /**
   * 启动时一次：reconcile + 扫 AWAITING 的 pendings（timer / resolved）。
   * @see doc/structurizr/INNER-BRAIN-AWAITING-LIFECYCLE.md §5.3
   */
  async bootstrap(): Promise<void> {
    this.opts.reconcileOnBootstrap?.();
    await this.tick();
  }

  start(): void {
    if (this.timer) return;
    void this.bootstrap().catch((e) => console.error('[change-watcher] bootstrap error:', e));
    this.timer = setInterval(() => {
      this.tick().catch((e) => console.error('[change-watcher] tick error:', e));
    }, this.opts.pollMs ?? DEFAULT_POLL_MS);
    console.log('[change-watcher] started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ── 主循环 ──────────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    const tasks = this.opts.registry.list().filter(
      (t) => t.status === 'AWAITING' || t.status === 'BLOCKED', // BLOCKED 兼容遗留
    );
    for (const task of tasks) {
      await this.tickTask(task).catch((e) =>
        console.error(`[change-watcher] task ${task.instanceId} error:`, e),
      );
    }
  }

  private async tickTask(task: TaskRecord): Promise<void> {
    if (!fs.existsSync(task.workDir)) return;
    const brainDir = path.join(task.workDir, '.brain');
    if (!fs.existsSync(path.join(brainDir, 'pendings.json'))) return;

    // 1. 时间推进（纯数据；幂等）
    const fired = resolveDueTimers(brainDir);
    const expired = expireOverduePendings(brainDir);

    // 2. 决定是否需要 spawn 一段 burst
    const unconsumed = listUnconsumedResolved(brainDir);
    const stillActive = listActivePendings(brainDir);

    if (unconsumed.length === 0) return;        // 没什么可消费的
    if (fired.length + expired.length === 0 && stillActive.length > 0) {
      // 没有刚翻牌的事件,且仍有等的;略过(避免反复 spawn)
      // 但 fall-through: unconsumed > 0 说明上次有外部 resolve(IM)
    }

    // 3. 去重：同一任务正在 wake 时不重复 spawn
    if (this.inFlightWakeups.has(task.instanceId)) return;

    // 4. 检查 pid 是否还活着——还活着说明 worker 在跑,等它退出
    if (task.pid && isPidAlive(task.pid)) {
      console.log(`[change-watcher] task ${task.instanceId} pid ${task.pid} still alive, skip spawn`);
      return;
    }

    console.log(
      `[change-watcher] waking task ${task.instanceId}: fired=${fired.length} expired=${expired.length} unconsumed=${unconsumed.length}`,
    );
    this.inFlightWakeups.add(task.instanceId);

    // 5. 消费 resolved pending，避免下一轮 tick 重复唤醒
    markConsumed(brainDir, unconsumed.map((p) => p.id));

    // 6. spawn worker —— 委托给调用方提供的 spawnTask（含完整 KPI / reflexion hook）
    try {
      const res = this.opts.spawnTask(task);
      if (!res.ok) {
        this.inFlightWakeups.delete(task.instanceId);
        console.error(`[change-watcher] spawnTask failed for ${task.instanceId}: ${res.error ?? '-'}`);
        return;
      }
      // 调用方会在自己的 onExit 里清理 pid;此处只清 inFlight 标记
      const cleanup = setInterval(() => {
        const cur = this.opts.registry.get(task.instanceId);
        if (!cur || cur.status !== 'RUNNING') {
          this.inFlightWakeups.delete(task.instanceId);
          clearInterval(cleanup);
        }
      }, 2000);
    } catch (e) {
      this.inFlightWakeups.delete(task.instanceId);
      console.error(`[change-watcher] failed to spawn worker for ${task.instanceId}:`, e);
    }
  }

  // ── 外部接口：IM 回复匹配 ask_user pending ──────────────────────────────

  /**
   * 用户在 IM 中回复后调用：
   * 在指定 task 的 pendings.json 里找匹配的 ask_user pending（按 ctxRef 或最近一个），
   * 把它 resolve 为用户回复。下一次 tick 会被 spawn 起来消费。
   */
  resolveAskUser(taskInstanceId: string, replyText: string, ctxRef?: string): PendingItem | null {
    const task = this.opts.registry.get(taskInstanceId);
    if (!task) return null;
    const brainDir = path.join(task.workDir, '.brain');
    if (!fs.existsSync(path.join(brainDir, 'pendings.json'))) return null;

    let target: PendingItem | null = null;
    if (ctxRef) {
      target = findByCtxRef(brainDir, ctxRef);
    } else {
      // 选最近创建的 ask_user 状态为 pending 的项
      const list = listActivePendings(brainDir).filter((p) => p.kind === 'ask_user');
      target = list.length > 0 ? list[list.length - 1] ?? null : null;
    }
    if (!target) return null;
    return resolvePending(brainDir, target.id, { result: { reply: replyText } });
  }

  /**
   * 唤醒一个命名信号：在指定 task 的 pendings.json 中查找
   * kind=signal 且 spec.signal_name === name 的 pending，resolve 之。
   */
  resolveSignal(taskInstanceId: string, signalName: string, payload?: unknown): PendingItem | null {
    const task = this.opts.registry.get(taskInstanceId);
    if (!task) return null;
    const brainDir = path.join(task.workDir, '.brain');
    if (!fs.existsSync(path.join(brainDir, 'pendings.json'))) return null;

    const list = listActivePendings(brainDir);
    const target = list.find((p) =>
      p.kind === 'signal' && (p.spec as { signal_name?: string }).signal_name === signalName,
    );
    if (!target) return null;
    return resolvePending(brainDir, target.id, { result: payload ?? { signal: signalName, fired_at: new Date().toISOString() } });
  }
}

// ── 工厂 ──────────────────────────────────────────────────────────────────────

export function createChangeWatcher(opts: ChangeWatcherOptions): ChangeWatcher {
  return new ChangeWatcher(opts);
}

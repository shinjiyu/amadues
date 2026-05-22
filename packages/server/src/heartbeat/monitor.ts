/**
 * 心跳监控器（环境侧）
 *
 * 负责：
 * 1. 定期拉取 agent 行为快照
 * 2. 与上一次快照比对
 * 3. 连续 N 次无变化判定死亡（N 默认 3）
 * 4. born 事件处理：无 born 直接判定死亡
 */

import type {
  AgentSnapshot,
  AliveCallback,
  DeathCallback,
  HeartbeatCheckResult,
  HeartbeatConfig,
  HeartbeatStatus,
  IActionLogStore,
  IHeartbeatMonitor,
  ISnapshotProvider,
  ResolvedHeartbeatConfig,
} from './types.js';
import { BORN_OPERATION_TYPE, HeartbeatStatus as HS } from './types.js';

/** 默认配置值 */
const DEFAULT_CHECK_INTERVAL_MS = 5000;
const DEFAULT_DEATH_THRESHOLD = 3;

/**
 * 解析并填充心跳配置的默认值
 */
export function resolveConfig(config: HeartbeatConfig): ResolvedHeartbeatConfig {
  return {
    checkIntervalMs: config.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS,
    deathThreshold: config.deathThreshold ?? DEFAULT_DEATH_THRESHOLD,
    agentId: config.agentId,
  };
}

/**
 * 心跳监控器实现
 *
 * 判定流程：
 * 1. 第一次检测：检查是否有 born 事件 → 无 born → 判定死亡
 * 2. 后续检测：比对当前快照与上次快照的日志条目数
 *    - 有变化（条目数增加）→ 存活，重置计数
 *    - 无变化 → 连续无变化计数 +1
 *    - 计数 >= N → 判定死亡
 */
export class HeartbeatMonitor implements IHeartbeatMonitor {
  private readonly config: ResolvedHeartbeatConfig;
  private readonly logStore: IActionLogStore;
  private readonly snapshotProvider: ISnapshotProvider;

  private status: HeartbeatStatus = HS.WaitingForBorn;
  private noChangeCount = 0;
  private lastLogEntryCount = 0;
  private timerHandle: ReturnType<typeof setInterval> | null = null;

  private deathCallbacks: DeathCallback[] = [];
  private aliveCallbacks: AliveCallback[] = [];

  /** born 事件是否已确认 */
  private bornConfirmed = false;
  /** 是否是首次检测（需要校验 born 事件） */
  private isFirstCheck = true;

  constructor(
    config: HeartbeatConfig,
    logStore: IActionLogStore,
    snapshotProvider: ISnapshotProvider,
  ) {
    this.config = resolveConfig(config);
    this.logStore = logStore;
    this.snapshotProvider = snapshotProvider;
  }

  // ─── 公开方法 ─────────────────────────────────────────────

  start(): void {
    if (this.timerHandle !== null) {
      return; // 已启动，避免重复
    }

    // 立即执行一次检测
    void this.performCheck();

    // 定时检测
    this.timerHandle = setInterval(() => {
      void this.performCheck();
    }, this.config.checkIntervalMs);
  }

  stop(): void {
    if (this.timerHandle !== null) {
      clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
  }

  onDeath(callback: DeathCallback): void {
    this.deathCallbacks.push(callback);
  }

  onAlive(callback: AliveCallback): void {
    this.aliveCallbacks.push(callback);
  }

  getStatus(): HeartbeatStatus {
    return this.status;
  }

  getNoChangeCount(): number {
    return this.noChangeCount;
  }

  // ─── 私有方法 ─────────────────────────────────────────────

  /**
   * 执行一次心跳检测
   *
   * 判定逻辑：
   * 1. 首次检测时检查 born 事件
   * 2. 与上次快照比对日志条目数
   * 3. 连续 N 次无变化判定死亡
   */
  private async performCheck(): Promise<void> {
    // 如果已经判定死亡，不再继续检测
    if (this.status === HS.Dead) {
      return;
    }

    const snapshot = await this.snapshotProvider.capture(this.config.agentId);
    const logEntries = snapshot.logEntries;

    // 首次检测：校验 born 事件
    if (this.isFirstCheck) {
      this.isFirstCheck = false;
      const hasBorn = logEntries.some(
        (e) => e.operation_type === BORN_OPERATION_TYPE,
      );

      if (!hasBorn) {
        // 无 born 事件 → 直接判定死亡
        this.status = HS.Dead;
        this.bornConfirmed = false;
        this.noChangeCount = this.config.deathThreshold;

        const result = this.buildCheckResult(snapshot, false);
        this.fireDeath(result);
        this.stop();
        return;
      }

      // born 事件已确认
      this.bornConfirmed = true;
      this.status = HS.Alive;
      this.lastLogEntryCount = logEntries.length;
      this.noChangeCount = 0;

      const result = this.buildCheckResult(snapshot, true);
      this.fireAlive(result);
      return;
    }

    // 后续检测：比对日志条目数
    const currentCount = logEntries.length;
    const hasChange = currentCount > this.lastLogEntryCount;

    if (hasChange) {
      // 有新条目 → 存活，重置计数
      this.noChangeCount = 0;
      this.status = HS.Alive;
      this.lastLogEntryCount = currentCount;

      const result = this.buildCheckResult(snapshot, true);
      this.fireAlive(result);
    } else {
      // 无变化 → 计数 +1
      this.noChangeCount += 1;

      if (this.noChangeCount >= this.config.deathThreshold) {
        // 连续 N 次无变化 → 判定死亡
        this.status = HS.Dead;

        const result = this.buildCheckResult(snapshot, false);
        this.fireDeath(result);
        this.stop();
      } else {
        // 尚未达到阈值，继续等待
        const result = this.buildCheckResult(snapshot, false);
        this.fireAlive(result);
      }
    }
  }

  /**
   * 构建检测结果对象
   */
  private buildCheckResult(
    snapshot: AgentSnapshot,
    hasChange: boolean,
  ): HeartbeatCheckResult {
    return {
      checkedAt: snapshot.capturedAt,
      status: this.status,
      noChangeCount: this.noChangeCount,
      logEntryCount: snapshot.logEntries.length,
      hasChange,
    };
  }

  /**
   * 触发所有死亡回调
   */
  private fireDeath(result: HeartbeatCheckResult): void {
    for (const cb of this.deathCallbacks) {
      cb(this.config.agentId, result);
    }
  }

  /**
   * 触发所有存活回调
   */
  private fireAlive(result: HeartbeatCheckResult): void {
    for (const cb of this.aliveCallbacks) {
      cb(this.config.agentId, result);
    }
  }

  // ─── 测试辅助方法 ─────────────────────────────────────────

  /**
   * 手动触发一次检测（用于测试，跳过定时器）
   */
  async tick(): Promise<void> {
    await this.performCheck();
  }

  /**
   * 重置内部状态（用于测试）
   */
  reset(): void {
    this.stop();
    this.status = HS.WaitingForBorn;
    this.noChangeCount = 0;
    this.lastLogEntryCount = 0;
    this.bornConfirmed = false;
    this.isFirstCheck = true;
    this.deathCallbacks = [];
    this.aliveCallbacks = [];
  }
}

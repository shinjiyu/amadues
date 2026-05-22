/**
 * 记忆层（第四层）主模块
 *
 * 整合失败提取器、死亡日志写入器、决策注入器，
 * 提供统一的记忆层 API。
 *
 * 职责：
 * - Agent 死亡时：提取失败原因，写入持久化死亡日志
 * - Agent 重启时：读取历史死亡记录，注入避坑决策上下文
 * - 委托行为日志写入给 IActionLogStore（由心跳模块提供）
 *
 * 不重复实现心跳检测逻辑，不修改心跳核心数据结构。
 */

import type { ActionLogEntry, IActionLogStore } from '../heartbeat/types.js';
import type {
  DeathRecord,
  DecisionContext,
  IMemoryLayer,
  MemoryLayerConfig,
  ResolvedMemoryLayerConfig,
} from './types.js';
import { FailureExtractor } from './failure-extractor.js';
import { DeathLogger } from './death-logger.js';
import { DecisionInjector } from './decision-injector.js';

/**
 * 默认配置
 */
const DEFAULT_CONFIG: ResolvedMemoryLayerConfig = {
  logPath: './memory-death-log.jsonl',
  maxDeathRecords: 100,
};

/**
 * 解析配置并填充默认值
 */
export function resolveMemoryLayerConfig(
  config?: MemoryLayerConfig,
): ResolvedMemoryLayerConfig {
  return {
    logPath: config?.logPath ?? DEFAULT_CONFIG.logPath,
    maxDeathRecords: config?.maxDeathRecords ?? DEFAULT_CONFIG.maxDeathRecords,
  };
}

/**
 * 记忆层主实现
 *
 * 用法示例：
 * ```ts
 * const logStore = new InMemoryActionLogStore();
 * const memory = new MemoryLayer(logStore, { logPath: './death-log.jsonl' });
 *
 * // Agent 启动时写入 born 事件
 * await memory.writeBorn('agent-1');
 *
 * // Agent 执行操作时写入行为日志
 * await memory.writeAction('agent-1', 'file_read', 'workspace:data/config.json');
 *
 * // Agent 死亡时记录
 * await memory.recordDeath('agent-1', '连续3次检测无变化', 3);
 *
 * // Agent 重启时获取决策上下文
 * const ctx = await memory.getDecisionContext('agent-1');
 * if (ctx.inRecovery) {
 *   for (const hint of ctx.avoidanceHints) {
 *     console.log(`[${hint.level}] ${hint.message}`);
 *   }
 * }
 * ```
 */
export class MemoryLayer implements IMemoryLayer {
  private readonly config: ResolvedMemoryLayerConfig;
  private readonly logStore: IActionLogStore;
  private readonly extractor: FailureExtractor;
  private readonly deathLogger: DeathLogger;
  private readonly injector: DecisionInjector;

  /**
   * @param logStore - 行为日志存储（由心跳模块提供）
   * @param config - 记忆层配置
   */
  constructor(logStore: IActionLogStore, config?: MemoryLayerConfig) {
    this.config = resolveMemoryLayerConfig(config);
    this.logStore = logStore;
    this.extractor = new FailureExtractor(logStore);
    this.deathLogger = new DeathLogger({
      logPath: this.config.logPath,
    });
    this.injector = new DecisionInjector(this.deathLogger);
  }

  /**
   * 写入 born 事件到行为日志
   *
   * @param agentId - agent 标识
   */
  async writeBorn(agentId: string): Promise<void> {
    const entry: ActionLogEntry = {
      timestamp: Date.now(),
      operation_type: 'born',
      impact_scope: `agent:${agentId}`,
    };
    await this.logStore.append(agentId, entry);
  }

  /**
   * 写入一条行为日志条目
   *
   * @param agentId - agent 标识
   * @param operationType - 操作类型
   * @param impactScope - 影响范围
   */
  async writeAction(
    agentId: string,
    operationType: string,
    impactScope: string,
  ): Promise<void> {
    const entry: ActionLogEntry = {
      timestamp: Date.now(),
      operation_type: operationType,
      impact_scope: impactScope,
    };
    await this.logStore.append(agentId, entry);
  }

  /**
   * 记录一次死亡事件
   *
   * 心跳检测判定死亡时调用此方法：
   * 1. 从 ActionLogStore 提取当前会话的失败条目
   * 2. 构建 DeathRecord
   * 3. 持久化写入死亡日志文件
   *
   * @param agentId - agent 标识
   * @param deathCause - 死亡原因描述
   * @param noChangeCount - 连续无变化次数
   */
  async recordDeath(
    agentId: string,
    deathCause: string,
    noChangeCount: number,
  ): Promise<void> {
    const sessionSummary = await this.extractor.extract(agentId);
    const record: DeathRecord = {
      timestamp: Date.now(),
      agentId,
      deathCause,
      noChangeCount,
      sessionSummary,
    };
    await this.deathLogger.writeDeathLog(record);
  }

  /**
   * 获取 agent 重启后的决策上下文
   *
   * Agent 初始化时调用：
   * 1. 读取历史死亡记录
   * 2. 如果有记录，进入恢复模式，生成避坑提示
   * 3. 如果没有记录，正常启动
   *
   * @param agentId - agent 标识
   * @returns 决策上下文
   */
  async getDecisionContext(agentId: string): Promise<DecisionContext> {
    return this.injector.getDecisionContext(agentId);
  }

  /**
   * 读取所有死亡记录
   *
   * @param agentId - agent 标识
   */
  async readDeathRecords(agentId: string): Promise<DeathRecord[]> {
    return this.deathLogger.readAllDeathLogs(agentId);
  }

  /**
   * 获取失败提取器（供测试使用）
   */
  getExtractor(): FailureExtractor {
    return this.extractor;
  }

  /**
   * 获取死亡日志写入器（供测试使用）
   */
  getDeathLogger(): DeathLogger {
    return this.deathLogger;
  }

  /**
   * 获取决策注入器（供测试使用）
   */
  getDecisionInjector(): DecisionInjector {
    return this.injector;
  }
}

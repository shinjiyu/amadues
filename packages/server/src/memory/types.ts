/**
 * 记忆层（第四层）核心类型定义
 *
 * 本文件定义记忆层所需的全部类型，与心跳检测模块（src/heartbeat/types.ts）
 * 在语义上对齐，复用其 ActionLogEntry 等已有类型。
 *
 * 设计原则：
 * - 记忆层不重复实现心跳检测逻辑，只负责「从日志提取失败原因」
 *   和「在 agent 初始化时注入决策上下文」
 * - 不引入持久化数据库，使用内存 + 日志文件（依赖 IActionLogStore）
 * - 不修改心跳检测的核心数据结构
 */

import type { ActionLogEntry } from '../heartbeat/types.js';

// ============================================================
// 错误分类
// ============================================================

/**
 * 错误类别枚举
 *
 * 从日志的 operation_type 推断错误类型
 */
export enum FailureCategory {
  /** 未知/无法分类 */
  Unknown = 'unknown',
  /** 无响应（长时间无变化被判定死亡） */
  NoResponse = 'no_response',
  /** 运行时错误（异常、崩溃） */
  RuntimeError = 'runtime_error',
  /** 资源冲突（如文件被占用、API 限流） */
  ResourceConflict = 'resource_conflict',
  /** 参数/输入错误 */
  InputError = 'input_error',
  /** 重复操作错误 */
  DuplicateAction = 'duplicate_action',
}

// ============================================================
// 失败条目
// ============================================================

/**
 * 从日志中提取的失败条目
 *
 * 每条 FailureEntry 对应一次从日志中识别出的失败/异常行为。
 */
export interface FailureEntry {
  /** 失败发生的时间戳（Unix ms） */
  timestamp: number;
  /** 操作类型 */
  operation_type: string;
  /** 影响范围 */
  impact_scope: string;
  /** 错误类别 */
  category: FailureCategory;
  /** 失败描述（从日志推断） */
  description: string;
}

// ============================================================
// 会话摘要
// ============================================================

/**
 * 最近生命周期会话摘要
 *
 * 从最后一次 born 事件到死亡之间提取的信息。
 */
export interface SessionSummary {
  /** 当前 agent 标识 */
  agentId: string;
  /** born 事件时间戳（Unix ms），null 表示未找到 born */
  bornAt: number | null;
  /** 会话中所有行为日志条目数 */
  totalActions: number;
  /** 提取的失败条目列表 */
  failures: FailureEntry[];
  /** 所有唯一操作类型列表 */
  operationTypes: string[];
  /** 所有唯一影响范围列表 */
  impactScopes: string[];
}

// ============================================================
// 决策上下文
// ============================================================

/**
 * 避坑提示
 *
 * 根据历史失败原因生成的行动建议，注入 agent 决策上下文。
 */
export interface AvoidanceHint {
  /** 严重等级：info | warn | critical */
  level: 'info' | 'warn' | 'critical';
  /** 要避免的操作类型 */
  avoidOperationType?: string;
  /** 要避免的影响范围 */
  avoidImpactScope?: string;
  /** 人类可读的提示消息 */
  message: string;
}

/**
 * 决策注入上下文
 *
 * Agent 重启时注入的上下文，包含上次失败原因
 * 和避坑建议，帮助 agent 避免重复相同错误。
 */
export interface DecisionContext {
  /** 是否需要恢复模式 */
  inRecovery: boolean;
  /** agent ID */
  agentId: string;
  /** 历史累计死亡次数 */
  totalDeaths: number;
  /** 最近一次会话摘要 */
  lastSession: SessionSummary | null;
  /** 避坑提示列表 */
  avoidanceHints: AvoidanceHint[];
  /** 时间戳（生成上下文的时间） */
  generatedAt: number;
}

// ============================================================
// 死亡记录（持久化用）
// ============================================================

/**
 * 死亡记录
 *
 * 当心跳检测判定 agent 死亡时，记忆层写入此记录。
 * 格式为 JSONL，每行一条记录，追加写入。
 */
export interface DeathRecord {
  /** 死亡判定时间戳（Unix ms） */
  timestamp: number;
  /** agent 标识 */
  agentId: string;
  /** 死亡原因描述 */
  deathCause: string;
  /** 连续无变化次数 */
  noChangeCount: number;
  /** 会话摘要快照 */
  sessionSummary: SessionSummary;
}

// ============================================================
// 记忆层配置
// ============================================================

/**
 * 记忆层配置
 */
export interface MemoryLayerConfig {
  /** 持久化日志文件路径，默认 "./memory-death-log.jsonl" */
  logPath?: string;
  /** 每个 agent 最大保留的死亡记录数，默认 100 */
  maxDeathRecords?: number;
}

/**
 * 解析后的记忆层配置（含默认值）
 */
export interface ResolvedMemoryLayerConfig {
  logPath: string;
  maxDeathRecords: number;
}

// ============================================================
// 提取器接口
// ============================================================

/**
 * 失败提取器接口
 *
 * 从 ActionLogStore 中提取失败相关信息。
 */
export interface IFailureExtractor {
  /**
   * 提取指定 agent 最近生命周期中的失败条目
   *
   * 从最后一次 born 事件之后的日志中识别失败行为。
   *
   * @param agentId - agent 标识
   * @returns 会话摘要，包含失败列表
   */
  extract(agentId: string): Promise<SessionSummary>;
}

// ============================================================
// 决策注入器接口
// ============================================================

/**
 * 决策注入器接口
 *
 * Agent 重启时调用，生成决策上下文。
 */
export interface IDecisionInjector {
  /**
   * 为 agent 初始化生成决策上下文
   *
   * 读取历史死亡记录，分析上次失败原因，
   * 生成避坑提示供 agent 决策时参考。
   *
   * @param agentId - agent 标识
   * @returns 决策上下文
   */
  getDecisionContext(agentId: string): Promise<DecisionContext>;
}

// ============================================================
// 记忆层主接口
// ============================================================

/**
 * 记忆层主接口
 *
 * 整合失败提取、死亡记录写入、重启恢复等功能。
 */
export interface IMemoryLayer {
  /**
   * 记录一次死亡事件
   *
   * 心跳检测判定死亡时调用。
   * 提取失败原因，持久化死亡记录。
   *
   * @param agentId - agent 标识
   * @param deathCause - 死亡原因描述
   * @param noChangeCount - 连续无变化次数
   */
  recordDeath(
    agentId: string,
    deathCause: string,
    noChangeCount: number,
  ): Promise<void>;

  /**
   * 获取 agent 重启后的决策上下文
   *
   * Agent 初始化时调用，注入历史失败信息。
   *
   * @param agentId - agent 标识
   */
  getDecisionContext(agentId: string): Promise<DecisionContext>;

  /**
   * 写入一条 born 事件到行为日志
   * （委托给 IActionLogStore）
   *
   * @param agentId - agent 标识
   */
  writeBorn(agentId: string): Promise<void>;

  /**
   * 写入一条行为日志条目
   * （委托给 IActionLogStore）
   *
   * @param agentId - agent 标识
   * @param operationType - 操作类型
   * @param impactScope - 影响范围
   */
  writeAction(
    agentId: string,
    operationType: string,
    impactScope: string,
  ): Promise<void>;

  /**
   * 读取所有死亡记录
   */
  readDeathRecords(agentId: string): Promise<DeathRecord[]>;
}

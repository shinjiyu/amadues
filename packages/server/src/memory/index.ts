/**
 * 记忆层（第四层）模块导出
 *
 * 模块结构：
 * - types.ts: 核心类型定义
 * - failure-extractor.ts: 失败提取器（从 ActionLog 提取失败条目）
 * - death-logger.ts: 持久化死亡日志写入/读取器
 * - decision-injector.ts: 决策注入器（生成避坑上下文）
 * - memory-layer.ts: 记忆层主模块（整合上述组件）
 */

// 类型定义
export {
  FailureCategory,
  type FailureEntry,
  type SessionSummary,
  type AvoidanceHint,
  type DecisionContext,
  type DeathRecord,
  type MemoryLayerConfig,
  type ResolvedMemoryLayerConfig,
  type IFailureExtractor,
  type IDecisionInjector,
  type IMemoryLayer,
} from './types.js';

// 失败提取器
export { FailureExtractor } from './failure-extractor.js';

// 死亡日志写入/读取器
export {
  DeathLogger,
  type DeathLoggerOptions,
} from './death-logger.js';

// 决策注入器
export { DecisionInjector } from './decision-injector.js';

// 记忆层主模块
export {
  MemoryLayer,
  resolveMemoryLayerConfig,
} from './memory-layer.js';

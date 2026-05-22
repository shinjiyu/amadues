/**
 * 失败提取器
 *
 * 从 IActionLogStore 中提取 agent 最近生命周期中的失败条目。
 * 识别逻辑：从最后一次 born 事件之后，查找 operation_type 中
 * 包含 error/exception/failure/fail/crash/timeout 等关键词的条目。
 *
 * 职责边界：
 * - 只读取 IActionLogStore，不写入
 * - 不重复实现心跳检测逻辑
 * - 不修改心跳检测的核心数据结构
 */

import type { ActionLogEntry, IActionLogStore } from '../heartbeat/types.js';
import {
  type FailureEntry,
  type SessionSummary,
  FailureCategory,
} from './types.js';

/**
 * 失败关键词映射：
 * operation_type 中的关键词 → 对应的 FailureCategory
 */
const FAILURE_KEYWORD_MAP: Array<{
  keywords: string[];
  category: FailureCategory;
}> = [
  {
    keywords: ['error', 'exception', 'crash', 'panic', 'fatal'],
    category: FailureCategory.RuntimeError,
  },
  {
    keywords: ['timeout', 'no_response', 'unresponsive', 'hang', 'stuck'],
    category: FailureCategory.NoResponse,
  },
  {
    keywords: ['conflict', 'locked', 'busy', 'rate_limit', 'throttle'],
    category: FailureCategory.ResourceConflict,
  },
  {
    keywords: ['invalid', 'bad_request', 'validation', 'parse_error', 'type_error'],
    category: FailureCategory.InputError,
  },
  {
    keywords: ['duplicate', 'already_exists', 'repeat'],
    category: FailureCategory.DuplicateAction,
  },
  {
    keywords: ['fail', 'failure', 'abort', 'reject'],
    category: FailureCategory.RuntimeError,
  },
];

/**
 * 根据 operation_type 推断 FailureCategory
 */
function classifyFailure(operationType: string): FailureCategory {
  const lower = operationType.toLowerCase();
  for (const { keywords, category } of FAILURE_KEYWORD_MAP) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        return category;
      }
    }
  }
  return FailureCategory.Unknown;
}

/**
 * 生成失败描述
 */
function describeFailure(entry: ActionLogEntry, category: FailureCategory): string {
  const categoryLabel: Record<FailureCategory, string> = {
    [FailureCategory.Unknown]: 'unknown error',
    [FailureCategory.NoResponse]: 'no response / timeout',
    [FailureCategory.RuntimeError]: 'runtime error',
    [FailureCategory.ResourceConflict]: 'resource conflict',
    [FailureCategory.InputError]: 'input/validation error',
    [FailureCategory.DuplicateAction]: 'duplicate action detected',
  };

  return `[${categoryLabel[category]}] ${entry.operation_type} on ${entry.impact_scope}`;
}

/**
 * 失败提取器实现
 *
 * 从 IActionLogStore 读取日志，识别失败条目。
 */
export class FailureExtractor {
  private readonly logStore: IActionLogStore;

  /**
   * @param logStore - 行为日志存储（由心跳模块提供）
   */
  constructor(logStore: IActionLogStore) {
    this.logStore = logStore;
  }

  /**
   * 提取指定 agent 最近生命周期中的失败条目
   *
   * 算法：
   * 1. 读取该 agent 的全部日志
   * 2. 找到最后一次 born 事件的位置
   * 3. 从 born 之后（或全部，如果没有 born）的日志中
   *    筛选 operation_type 匹配失败关键词的条目
   * 4. 构建 SessionSummary
   *
   * @param agentId - agent 标识
   * @returns 会话摘要
   */
  async extract(agentId: string): Promise<SessionSummary> {
    const allEntries = await this.logStore.read(agentId);

    // 找到最后一次 born 事件的索引
    let lastBornIndex = -1;
    let bornAt: number | null = null;
    for (let i = allEntries.length - 1; i >= 0; i--) {
      if (allEntries[i].operation_type === 'born') {
        lastBornIndex = i;
        bornAt = allEntries[i].timestamp;
        break;
      }
    }

    // 当前生命周期中的条目（born 之后的，包含 born）
    const sessionEntries =
      lastBornIndex >= 0
        ? allEntries.slice(lastBornIndex)
        : allEntries;

    // 筛选失败条目
    const failures: FailureEntry[] = [];
    for (const entry of sessionEntries) {
      const lowerOp = entry.operation_type.toLowerCase();
      const isFailure = FAILURE_KEYWORD_MAP.some(({ keywords }) =>
        keywords.some((kw) => lowerOp.includes(kw)),
      );

      if (isFailure && !lowerOp.includes('born')) {
        const category = classifyFailure(entry.operation_type);
        failures.push({
          timestamp: entry.timestamp,
          operation_type: entry.operation_type,
          impact_scope: entry.impact_scope,
          category,
          description: describeFailure(entry, category),
        });
      }
    }

    // 收集唯一的操作类型和影响范围
    const operationTypes = [
      ...new Set(sessionEntries.map((e) => e.operation_type)),
    ];
    const impactScopes = [
      ...new Set(sessionEntries.map((e) => e.impact_scope)),
    ];

    return {
      agentId,
      bornAt,
      totalActions: sessionEntries.length,
      failures,
      operationTypes,
      impactScopes,
    };
  }

  /**
   * 获取行为日志存储（供上层模块使用）
   */
  getLogStore(): IActionLogStore {
    return this.logStore;
  }
}

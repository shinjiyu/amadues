/**
 * 决策注入器
 *
 * Agent 重启时调用，读取历史死亡记录，分析上次失败原因，
 * 生成避坑提示供 agent 决策时参考。
 *
 * 职责边界：
 * - 只读取死亡日志，不写入
 * - 不修改心跳检测数据结构
 * - 不重复实现心跳检测逻辑
 */

import type {
  AvoidanceHint,
  DeathRecord,
  DecisionContext,
  SessionSummary,
} from './types.js';
import { FailureCategory } from './types.js';
import type { DeathLogger } from './death-logger.js';

/**
 * 根据失败类别生成对应的避坑提示
 */
function generateHintsFromFailures(
  summary: SessionSummary,
): AvoidanceHint[] {
  const hints: AvoidanceHint[] = [];

  // 按类别分组
  const byCategory = new Map<FailureCategory, number>();
  for (const failure of summary.failures) {
    const count = byCategory.get(failure.category) ?? 0;
    byCategory.set(failure.category, count + 1);
  }

  for (const [category, count] of byCategory) {
    switch (category) {
      case FailureCategory.NoResponse:
        hints.push({
          level: 'critical',
          message: `上次因长时间无响应死亡：连续 ${summary.totalActions} 条日志后停止变化。建议增加中间状态写入频率或拆分长任务`,
        });
        break;
      case FailureCategory.RuntimeError:
        hints.push({
          level: 'critical',
          message: `上次发生了 ${count} 次运行时错误。请检查操作类型的参数和前置条件`,
        });
        break;
      case FailureCategory.ResourceConflict:
        hints.push({
          level: 'warn',
          message: `上次发生了 ${count} 次资源冲突。请确保操作前检查资源可用性`,
        });
        break;
      case FailureCategory.InputError:
        hints.push({
          level: 'warn',
          message: `上次发生了 ${count} 次输入/验证错误。请确认输入参数格式`,
        });
        break;
      case FailureCategory.DuplicateAction:
        hints.push({
          level: 'info',
          message: `上次发生了 ${count} 次重复操作。请检查幂等性保证`,
        });
        break;
      default:
        hints.push({
          level: 'info',
          message: `上次会话中有 ${count} 次未分类异常`,
        });
    }
  }

  // 特殊提示：上次失败最多的操作类型
  const opTypeCounts = new Map<string, number>();
  for (const f of summary.failures) {
    const c = opTypeCounts.get(f.operation_type) ?? 0;
    opTypeCounts.set(f.operation_type, c + 1);
  }
  const sortedOps = [...opTypeCounts.entries()].sort((a, b) => b[1] - a[1]);
  if (sortedOps.length > 0) {
    const [mostFrequentOp] = sortedOps[0];
    hints.push({
      level: 'warn',
      avoidOperationType: mostFrequentOp,
      message: `上次会话中最常失败的操作类型是 "${mostFrequentOp}"，建议优先排查此操作`,
    });
  }

  // 特殊提示：上次失败最多的影响范围
  const scopeCounts = new Map<string, number>();
  for (const f of summary.failures) {
    const c = scopeCounts.get(f.impact_scope) ?? 0;
    scopeCounts.set(f.impact_scope, c + 1);
  }
  const sortedScopes = [...scopeCounts.entries()].sort((a, b) => b[1] - a[1]);
  if (sortedScopes.length > 0) {
    const [mostFrequentScope] = sortedScopes[0];
    hints.push({
      level: 'warn',
      avoidImpactScope: mostFrequentScope,
      message: `上次会话中最常失败的影响范围是 "${mostFrequentScope}"，建议谨慎操作此范围`,
    });
  }

  return hints;
}

/**
 * 决策注入器实现
 *
 * Agent 重启时调用 getDecisionContext() 获取决策上下文。
 */
export class DecisionInjector {
  private readonly deathLogger: DeathLogger;

  /**
   * @param deathLogger - 死亡日志写入/读取器
   */
  constructor(deathLogger: DeathLogger) {
    this.deathLogger = deathLogger;
  }

  /**
   * 为 agent 初始化生成决策上下文
   *
   * 算法：
   * 1. 读取该 agent 的所有历史死亡记录
   * 2. 如果有历史记录：
   *    - inRecovery = true
   *    - 从最近一条 DeathRecord 中提取 sessionSummary
   *    - 根据 failures 生成避坑提示
   * 3. 如果没有历史记录：
   *    - inRecovery = false
   *    - lastSession = null
   *    - avoidanceHints = []
   *
   * @param agentId - agent 标识
   * @returns 决策上下文
   */
  async getDecisionContext(agentId: string): Promise<DecisionContext> {
    const allRecords = await this.deathLogger.readAllDeathLogs(agentId);
    const totalDeaths = allRecords.length;

    if (totalDeaths === 0) {
      return {
        inRecovery: false,
        agentId,
        totalDeaths: 0,
        lastSession: null,
        avoidanceHints: [],
        generatedAt: Date.now(),
      };
    }

    const lastRecord = allRecords[allRecords.length - 1];
    const hints = generateHintsFromFailures(lastRecord.sessionSummary);

    return {
      inRecovery: true,
      agentId,
      totalDeaths,
      lastSession: lastRecord.sessionSummary,
      avoidanceHints: hints,
      generatedAt: Date.now(),
    };
  }
}

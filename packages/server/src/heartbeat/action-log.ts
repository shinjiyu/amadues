/**
 * 行为日志存储（环境侧实现）
 *
 * 基于内存的 IActionLogStore 实现。
 * Agent 无法调用写入方法——只有环境侧持有写入权限。
 */

import type {
  ActionLogEntry,
  IActionLogStore,
} from './types.js';

/**
 * 内存版行为日志存储
 *
 * 所有日志数据存储在 Map<string, ActionLogEntry[]> 中。
 * 生产环境可替换为持久化存储实现。
 */
export class InMemoryActionLogStore implements IActionLogStore {
  /** agentId → 日志条目列表（按 timestamp 升序） */
  private logs: Map<string, ActionLogEntry[]> = new Map();

  /** 追加一条行为日志（仅环境侧调用） */
  async append(agentId: string, entry: ActionLogEntry): Promise<void> {
    if (!this.logs.has(agentId)) {
      this.logs.set(agentId, []);
    }
    this.logs.get(agentId)!.push(entry);
    // 保持按 timestamp 升序
    this.logs.get(agentId)!.sort((a, b) => a.timestamp - b.timestamp);
  }

  /** 读取指定 agent 的全部行为日志 */
  async read(agentId: string): Promise<ActionLogEntry[]> {
    return [...(this.logs.get(agentId) ?? [])];
  }

  /** 获取指定 agent 的行为日志条目数 */
  async count(agentId: string): Promise<number> {
    return this.logs.get(agentId)?.length ?? 0;
  }

  /** 清除指定 agent 的全部行为日志 */
  async clear(agentId: string): Promise<void> {
    this.logs.delete(agentId);
  }

  /** 获取全部已注册的 agent ID（测试辅助） */
  getAgentIds(): string[] {
    return [...this.logs.keys()];
  }
}

/**
 * 快照提供者实现
 *
 * 基于 IActionLogStore 的 ISnapshotProvider 实现。
 * 每次 capture 调用会从日志存储中读取最新日志并生成快照。
 */

import type {
  AgentSnapshot,
  IActionLogStore,
  ISnapshotProvider,
} from './types.js';

/**
 * 基于日志存储的快照提供者
 *
 * 每次 capture 时：
 * 1. 从 logStore 读取指定 agent 的全部日志
 * 2. 生成 AgentSnapshot（包含当前时间戳）
 */
export class LogStoreSnapshotProvider implements ISnapshotProvider {
  private readonly logStore: IActionLogStore;

  constructor(logStore: IActionLogStore) {
    this.logStore = logStore;
  }

  async capture(agentId: string): Promise<AgentSnapshot> {
    const logEntries = await this.logStore.read(agentId);
    return {
      agentId,
      logEntries,
      capturedAt: Date.now(),
    };
  }
}

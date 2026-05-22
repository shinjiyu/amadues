/**
 * M6 · Mem0 Client (Layer 3 — 长期语义记忆)
 *
 * 全局单实例 Mem0 服务，各 agent 以 user_id = agent_id 隔离。
 * 实现：调用 Mem0 REST API（或 mem0ai SDK）。
 */

export interface Mem0Client {
  /** 将内容写入 Mem0（M 阶段调用） */
  add(content: string, agentId: string): Promise<void>;
  /** 检索与 query 相关的记忆（R 阶段调用） */
  search(query: string, agentId: string, limit?: number): Promise<string[]>;
}

export { createMem0Client } from './client.js';

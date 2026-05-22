/**
 * M5 · Memory (Layer 1 + Layer 2)
 *
 * Layer 1：pi-mono 会话内上下文（由 LLM Adapter 持有，此处不管理）
 * Layer 2：近期记忆 —— Daily Log（追加） + TASKS（结构化状态）
 *          存放于 <tempDir>/memory/
 *
 * 协议文档：doc/protocols/memory-interface.md（待建）
 */

export interface MemoryLayer2 {
  /** 追加一条 Daily Log */
  appendDailyLog(entry: string): void;
  /** 读取今日 Daily Log */
  readDailyLog(): string;
  /** 读取当前 TASKS 状态 */
  readTasks(): string;
  /** 覆写 TASKS 状态 */
  writeTasks(content: string): void;
}

export { createMemoryLayer2 } from './memory.js';

/**
 * M1 · Identity & Paths
 *
 * 职责：
 * - 计算 agent_id = SHA256(MAC + absolutePath).slice(0,16)
 * - 确定临时目录与工作目录
 * - 路径排他锁（同一路径只能跑一个 agent）
 */

export interface AgentIdentity {
  agentId: string;
  mac: string;
  agentPath: string;    // 绝对路径（--dir 参数）
  tempDir: string;      // <全局临时目录>/<agentId>
  workDir: string;      // 工作目录（agent 的操作对象）
}

export { resolveIdentity, deriveAgentId, globalTmpDir, acquirePathLock, releasePathLock } from './identity.js';

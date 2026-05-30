/**
 * Agent 侧行为日志写入辅助
 *
 * 提供两个写入入口：
 *   - writeBornEvent():  在 agent 初始化时写入 born 事件
 *   - writeActionEvent(): 在动作执行后写入 act 事件
 *
 * 设计原则：
 *   - 所有写入都委托给 IActionLogStore，agent 侧不直接持有日志数组引用
 *   - born 事件仅由 writeBornEvent() 写入，外部无法伪造
 *   - impact_scope 由调用方提供，描述该行为的外部可观测影响
 */

import type { IActionLogStore, ActionLogEntry } from './types.js';
import { BORN_OPERATION_TYPE } from './types.js';

/**
 * 写入 born 事件 — agent 初始化时调用
 *
 * born 事件是 agent 生命周期的第一条日志，表示 agent 已启动并注册到环境。
 * 此函数仅在 agent 启动时调用一次，后续不再写入 born 类型事件。
 *
 * @param logStore  行为日志存储（环境侧持有写入权）
 * @param agentId   agent 唯一标识
 * @param impactScope  影响范围描述（如 "agent:<sid> workspace:<workspaceId>"）
 */
export async function writeBornEvent(
  logStore: IActionLogStore,
  agentId: string,
  impactScope: string,
): Promise<void> {
  const entry: ActionLogEntry = {
    timestamp: Date.now(),
    operation_type: BORN_OPERATION_TYPE,
    impact_scope: impactScope,
  };
  await logStore.append(agentId, entry);
  console.log(`[utlra][behavior-log] born event written for agent=${agentId}`);
}

/**
 * 写入动作执行事件 — 每次工具调用完成后调用
 *
 * 记录 agent 通过工具产生的外部可观测副作用。
 * operation_type 不包含 born（born 只在初始化时写入）。
 *
 * @param logStore       行为日志存储（环境侧持有写入权）
 * @param agentId        agent 唯一标识
 * @param operationType  操作类型（如 "file_write"、"api_call"、"message_send"）
 * @param impactScope    影响范围描述（如 "workspace:abc/file:main.ts"）
 */
export async function writeActionEvent(
  logStore: IActionLogStore,
  agentId: string,
  operationType: string,
  impactScope: string,
): Promise<void> {
  // 安全守卫：阻止写入 born 类型（born 只在初始化时写入）
  if (operationType === BORN_OPERATION_TYPE) {
    console.warn(`[utlra][behavior-log] rejected attempt to write born event via writeActionEvent for agent=${agentId}`);
    return;
  }
  const entry: ActionLogEntry = {
    timestamp: Date.now(),
    operation_type: operationType,
    impact_scope: impactScope,
  };
  await logStore.append(agentId, entry);
}

/**
 * 将工具名映射为操作类型
 *
 * 外脑工具名 → 行为日志 operation_type 的映射表。
 * 未在映射表中的工具名直接使用原始工具名。
 */
const TOOL_NAME_TO_OPERATION_TYPE: Record<string, string> = {
  reply_to_user: 'message_send',
  set_goal: 'goal_set',
  start_self_update: 'self_update_start',
  list_inner_brains: 'status_read',
  stop_inner_brain: 'brain_stop',
  send_directive: 'directive_send',
  get_time: 'time_read',
  search_thread: 'thread_search',
  read_file: 'file_read',
  send_file: 'file_send',
  read_inner_status: 'status_read',
  read_memory: 'memory_read',
  update_tasks: 'tasks_update',
  read_performance_goals: 'performance_goals_read',
  manage_performance_goal: 'performance_goal_manage',
  post_to_im: 'message_send',
  keychain_put: 'credential_write',
  keychain_get: 'credential_read',
  keychain_entries: 'credential_read',
  memory_block_list: 'memory_block_read',
  memory_block_create: 'memory_block_write',
  memory_block_update: 'memory_block_write',
  memory_block_delete_block: 'memory_block_write',
  memory_block_entries: 'memory_block_read',
  memory_block_get: 'memory_block_read',
  memory_block_put: 'memory_block_write',
  memory_block_delete: 'memory_block_write',
};

/**
 * 将工具名转换为行为日志的 operation_type
 *
 * @param toolName  外脑工具名
 * @returns 对应的 operation_type
 */
export function toolNameToOperationType(toolName: string): string {
  return TOOL_NAME_TO_OPERATION_TYPE[toolName] ?? toolName;
}

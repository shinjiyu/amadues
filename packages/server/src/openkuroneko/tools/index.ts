/**
 * M8 · Work Agent 工具集
 *
 * 工具列表（按 SCL 原子能力）：
 *   read_file, write_file, edit_file, shell_exec,
 *   web_search, get_time, reply_to_user, run_agent,
 *   read_write_structured_state, capability_gap_handler
 */

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface ToolParam {
  type: string;
  description: string;
  enum?: string[];
}

export interface Tool {
  name: string;
  description: string;
  /** Explicit parameter schema — improves tool-call compliance for all models. */
  parameters?: Record<string, ToolParam>;
  /** Parameter names that are required. */
  required?: string[];
  call(args: Record<string, unknown>): Promise<ToolResult>;
}

export interface ToolRegistry {
  get(name: string): Tool | undefined;
  list(): Tool[];
  schema(): object[];
}

export { createToolRegistry } from './registry.js';
export * from './definitions/index.js';

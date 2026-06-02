/**
 * ReAct 历史中瘦身 write_file / edit_file 的 tool_call 参数（正文已在磁盘）。
 *
 * ADL：doc/structurizr/DYFLOW-INNER-EXECUTOR.md §6.5 P2.5
 */

import type { Message } from '../adapter/index.js';

const BLOB_ARG_TOOLS = new Set(['write_file', 'edit_file']);

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function slimMinChars(): number {
  return readPositiveIntEnv('INNER_TOOL_ARGS_SLIM_MIN', 200);
}

/** 单条 tool 调用的参数瘦身（供 executor 按条应用） */
export function slimToolCallArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const min = slimMinChars();
  if (toolName === 'write_file') {
    const filePath = String(args['path'] ?? '');
    const content = String(args['content'] ?? '');
    if (content.length <= min) return args;
    const mode = args['mode'] != null ? String(args['mode']) : undefined;
    return {
      path: filePath,
      ...(mode ? { mode } : {}),
      content: `[${content.length} chars omitted; file on disk at ${filePath}]`,
    };
  }
  if (toolName === 'edit_file') {
    const filePath = String(args['path'] ?? '');
    const oldS = String(args['old_string'] ?? '');
    const newS = String(args['new_string'] ?? '');
    const out: Record<string, unknown> = { path: filePath };
    out['old_string'] =
      oldS.length > min ? `[${oldS.length} chars omitted]` : oldS;
    out['new_string'] =
      newS.length > min ? `[${newS.length} chars omitted]` : newS;
    return out;
  }
  return args;
}

export function shouldSlimToolCallArgs(toolName: string): boolean {
  return BLOB_ARG_TOOLS.has(toolName);
}

/** 成功写入/编辑后，将 assistant 消息里对应 tool_call 参数瘦身 */
export function slimAssistantToolCallsAfterSuccess(
  assistant: Message,
  slimTargets: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>,
): Message {
  if (!assistant.tool_calls?.length || slimTargets.length === 0) return assistant;
  const byId = new Map(slimTargets.map((t) => [t.toolCallId, t]));
  return {
    ...assistant,
    tool_calls: assistant.tool_calls.map((tc) => {
      const hit = byId.get(tc.id);
      if (!hit || !shouldSlimToolCallArgs(hit.toolName)) return tc;
      const slim = slimToolCallArgs(hit.toolName, hit.args);
      return {
        ...tc,
        function: {
          ...tc.function,
          name: hit.toolName,
          arguments: JSON.stringify(slim),
        },
      };
    }),
  };
}

/** 旧轮整段 assistant 的 tool_calls 参数瘦身 */
export function slimAssistantMessageToolCalls(msg: Message): Message {
  if (!msg.tool_calls?.length) return msg;
  return {
    ...msg,
    tool_calls: msg.tool_calls.map((tc) => {
      const name = tc.function?.name ?? '';
      if (!shouldSlimToolCallArgs(name)) return tc;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function?.arguments ?? '{}') as Record<string, unknown>;
      } catch {
        return tc;
      }
      const slim = slimToolCallArgs(name, args);
      return {
        ...tc,
        function: {
          ...tc.function,
          name,
          arguments: JSON.stringify(slim),
        },
      };
    }),
  };
}

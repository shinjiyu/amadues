/**
 * Outer LLM tools for Memory Block store.
 * @see doc/structurizr/MEMORY-BLOCKS.md §4
 */
import type { ToolDef } from './outer-tools.js';
import type { OuterToolContext, ToolCallResult } from './outer-tools.js';
import type { MemoryBlockStore } from './memory-block-store.js';

export const MEMORY_BLOCK_TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'memory_block_list',
      description:
        '列出当前 agent 可用的 Memory Block（如 keychain=凭证）。secret 块的 value 永不出现在外脑 prompt；需注入内脑时用 memory_block_bind。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_block_entries',
      description: '列出某 block 下的 entry key（kv_secret 块不返回 value）。',
      parameters: {
        type: 'object',
        properties: {
          block_id: { type: 'string', description: '块 ID，如 keychain' },
        },
        required: ['block_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_block_get',
      description:
        '读取 block 条目。kv_secret/keychain 外脑仅返回 metadata（kind、updated_at），不含 value；内脑请 bind 后 read_file。',
      parameters: {
        type: 'object',
        properties: {
          block_id: { type: 'string', description: '块 ID' },
          key: { type: 'string', description: 'entry key' },
        },
        required: ['block_id', 'key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_block_put',
      description:
        '写入或更新 block 条目。keychain 需 kind + value（Cookie/Token 等）；禁止写入 mem9 chat。',
      parameters: {
        type: 'object',
        properties: {
          block_id: { type: 'string', description: '块 ID，如 keychain' },
          key: { type: 'string', description: 'entry key，如 weibo' },
          kind: { type: 'string', description: '凭证类型：cookie / token / api_key / generic' },
          value: { type: 'string', description: 'secret 明文（仅存 vault，不进外脑 prompt）' },
        },
        required: ['block_id', 'key', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_block_delete',
      description: '删除 block 内一条 entry。',
      parameters: {
        type: 'object',
        properties: {
          block_id: { type: 'string', description: '块 ID' },
          key: { type: 'string', description: 'entry key' },
        },
        required: ['block_id', 'key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_block_bind',
      description:
        '将选定 entry 写入内脑 workDir/.brain/secrets/，供 read_file 使用。需 instance_id（list_inner_brains 可查）。',
      parameters: {
        type: 'object',
        properties: {
          block_id: { type: 'string', description: '块 ID' },
          keys: { type: 'string', description: '逗号或换行分隔的 key 列表' },
          instance_id: { type: 'string', description: '内脑 instance_id' },
        },
        required: ['block_id', 'keys', 'instance_id'],
      },
    },
  },
];

function parseKeysArg(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

function requireStore(ctx: OuterToolContext): MemoryBlockStore | null {
  return ctx.memoryBlockStore ?? null;
}

function resolveBindWorkDir(ctx: OuterToolContext, instanceId: string): string | null {
  const id = instanceId.trim();
  if (!id) return null;
  const rec = ctx.innerBrainRegistry?.get(id);
  if (!rec?.workDir) return null;
  return rec.workDir;
}

export async function execMemoryBlockList(ctx: OuterToolContext): Promise<ToolCallResult> {
  const store = requireStore(ctx);
  if (!store) return { replied: false, output: '（Memory Block 未启用）' };
  const blocks = store.listBlocks();
  const lines = blocks.map((b) => `- ${b.blockId} (${b.strategy}): ${b.description}`);
  return { replied: false, output: `Memory Blocks（${blocks.length}）：\n${lines.join('\n')}` };
}

export async function execMemoryBlockEntries(
  args: { block_id?: string },
  ctx: OuterToolContext,
): Promise<ToolCallResult> {
  const store = requireStore(ctx);
  if (!store) return { replied: false, output: '（Memory Block 未启用）' };
  const blockId = args.block_id?.trim() ?? '';
  if (!blockId) return { replied: false, output: '（block_id 为空）' };
  try {
    const keys = await store.listEntryKeys(blockId);
    if (keys.length === 0) return { replied: false, output: `block ${blockId}：（无条目）` };
    return { replied: false, output: `block ${blockId} keys（${keys.length}）：\n${keys.join('\n')}` };
  } catch (e) {
    return { replied: false, output: `（错误：${e instanceof Error ? e.message : String(e)}）` };
  }
}

export async function execMemoryBlockGet(
  args: { block_id?: string; key?: string },
  ctx: OuterToolContext,
): Promise<ToolCallResult> {
  const store = requireStore(ctx);
  if (!store) return { replied: false, output: '（Memory Block 未启用）' };
  const blockId = args.block_id?.trim() ?? '';
  const key = args.key?.trim() ?? '';
  if (!blockId || !key) return { replied: false, output: '（block_id 或 key 为空）' };
  try {
    const meta = await store.get(blockId, key);
    if (!meta) return { replied: false, output: `（${blockId}/${key} 不存在）` };
    return { replied: false, output: JSON.stringify(meta, null, 2) };
  } catch (e) {
    return { replied: false, output: `（错误：${e instanceof Error ? e.message : String(e)}）` };
  }
}

export async function execMemoryBlockPut(
  args: { block_id?: string; key?: string; kind?: string; value?: string },
  ctx: OuterToolContext,
): Promise<ToolCallResult> {
  const store = requireStore(ctx);
  if (!store) return { replied: false, output: '（Memory Block 未启用）' };
  const blockId = args.block_id?.trim() ?? '';
  const key = args.key?.trim() ?? '';
  const value = args.value ?? '';
  if (!blockId || !key) return { replied: false, output: '（block_id 或 key 为空）' };
  if (!value.trim()) return { replied: false, output: '（value 为空）' };
  try {
    const meta = await store.put(
      blockId,
      key,
      { kind: args.kind ?? 'generic', value },
      ctx.agentSid,
    );
    const len = value.length;
    return {
      replied: false,
      output: `已写入 ${blockId}/${key}（value.length=${len}，外脑不可见明文）。\n${JSON.stringify(meta, null, 2)}`,
    };
  } catch (e) {
    return { replied: false, output: `（错误：${e instanceof Error ? e.message : String(e)}）` };
  }
}

export async function execMemoryBlockDelete(
  args: { block_id?: string; key?: string },
  ctx: OuterToolContext,
): Promise<ToolCallResult> {
  const store = requireStore(ctx);
  if (!store) return { replied: false, output: '（Memory Block 未启用）' };
  const blockId = args.block_id?.trim() ?? '';
  const key = args.key?.trim() ?? '';
  if (!blockId || !key) return { replied: false, output: '（block_id 或 key 为空）' };
  try {
    const ok = await store.delete(blockId, key);
    return { replied: false, output: ok ? `已删除 ${blockId}/${key}` : `（${blockId}/${key} 不存在）` };
  } catch (e) {
    return { replied: false, output: `（错误：${e instanceof Error ? e.message : String(e)}）` };
  }
}

export async function execMemoryBlockBind(
  args: { block_id?: string; keys?: string; instance_id?: string },
  ctx: OuterToolContext,
): Promise<ToolCallResult> {
  const store = requireStore(ctx);
  if (!store) return { replied: false, output: '（Memory Block 未启用）' };
  const blockId = args.block_id?.trim() ?? '';
  const instanceId = args.instance_id?.trim() ?? '';
  const keys = parseKeysArg(args.keys);
  if (!blockId || !instanceId || keys.length === 0) {
    return { replied: false, output: '（block_id、instance_id 或 keys 无效）' };
  }
  const workDir = resolveBindWorkDir(ctx, instanceId);
  if (!workDir) return { replied: false, output: `（instance_id ${instanceId} 不存在或无 workDir）` };
  try {
    const paths = await store.bind(blockId, keys, workDir);
    return {
      replied: false,
      output:
        `已 bind ${keys.length} 条到 ${instanceId}：\n` +
        paths.map((p) => `- ${p}（内脑 read_file 可用）`).join('\n'),
    };
  } catch (e) {
    return { replied: false, output: `（错误：${e instanceof Error ? e.message : String(e)}）` };
  }
}

/** Transitional aliases → keychain block */
export async function execKeychainPut(
  args: { key?: string; kind?: string; value?: string },
  ctx: OuterToolContext,
): Promise<ToolCallResult> {
  return execMemoryBlockPut(
    { block_id: 'keychain', key: args.key, kind: args.kind, value: args.value },
    ctx,
  );
}

export async function execKeychainEntries(ctx: OuterToolContext): Promise<ToolCallResult> {
  return execMemoryBlockEntries({ block_id: 'keychain' }, ctx);
}

export async function execKeychainBind(
  args: { keys?: string; instance_id?: string },
  ctx: OuterToolContext,
): Promise<ToolCallResult> {
  return execMemoryBlockBind(
    { block_id: 'keychain', keys: args.keys, instance_id: args.instance_id },
    ctx,
  );
}

export async function dispatchMemoryBlockTool(
  name: string,
  args: Record<string, unknown>,
  ctx: OuterToolContext,
): Promise<ToolCallResult | null> {
  switch (name) {
    case 'memory_block_list':
      return execMemoryBlockList(ctx);
    case 'memory_block_entries':
      return execMemoryBlockEntries(args as { block_id?: string }, ctx);
    case 'memory_block_get':
      return execMemoryBlockGet(args as { block_id?: string; key?: string }, ctx);
    case 'memory_block_put':
      return execMemoryBlockPut(
        args as { block_id?: string; key?: string; kind?: string; value?: string },
        ctx,
      );
    case 'memory_block_delete':
      return execMemoryBlockDelete(args as { block_id?: string; key?: string }, ctx);
    case 'memory_block_bind':
      return execMemoryBlockBind(
        args as { block_id?: string; keys?: string; instance_id?: string },
        ctx,
      );
    case 'keychain_put':
      return execKeychainPut(args as { key?: string; kind?: string; value?: string }, ctx);
    case 'keychain_entries':
      return execKeychainEntries(ctx);
    case 'keychain_bind':
      return execKeychainBind(args as { keys?: string; instance_id?: string }, ctx);
    default:
      return null;
  }
}

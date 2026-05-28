/**
 * Outer LLM tools for Memory Block store.
 * @see doc/structurizr/MEMORY-BLOCKS.md §4
 */
import type { ToolDef } from './outer-tools.js';
import type { OuterToolContext, ToolCallResult } from './outer-tools.js';
import type { MemoryBlockStore } from './memory-block-store.js';
import type { BlockStrategyId } from './memory-block-strategies.js';

export const MEMORY_BLOCK_TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'memory_block_list',
      description:
        '列出当前 agent 的 Memory Block（本子）。含系统 keychain 与用户自建 notebook 等。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_block_create',
      description:
        '新建一个 Memory Block（记事本）。strategy 推荐 notebook；kv_secret 仅当确需凭证专用块时使用。系统块 keychain 已预置。',
      parameters: {
        type: 'object',
        properties: {
          block_id: { type: 'string', description: '新块 ID（字母数字、下划线、连字符）' },
          strategy: {
            type: 'string',
            description: 'notebook（默认，可读记事）或 kv_secret',
            enum: ['notebook', 'kv_secret'],
          },
          title: { type: 'string', description: '显示标题' },
          description: { type: 'string', description: '块用途说明' },
        },
        required: ['block_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_block_update',
      description: '更新块的 title/description（不能改 strategy）。系统块不可改。',
      parameters: {
        type: 'object',
        properties: {
          block_id: { type: 'string', description: '块 ID' },
          title: { type: 'string', description: '新标题' },
          description: { type: 'string', description: '新说明' },
        },
        required: ['block_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_block_delete_block',
      description: '删除整个块及其全部条目。不可删除 keychain 系统块。',
      parameters: {
        type: 'object',
        properties: {
          block_id: { type: 'string', description: '块 ID' },
        },
        required: ['block_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_block_entries',
      description: '列出某 block 下的 entry key。',
      parameters: {
        type: 'object',
        properties: {
          block_id: { type: 'string', description: '块 ID' },
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
        '读取 block 条目。notebook 返回 title/body；keychain 外脑仅 metadata（无 value 明文）。',
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
        '写入或更新条目。notebook：body（必填）+ 可选 title/tags；keychain：kind + value（Cookie/Token）。禁止写入 mem9。',
      parameters: {
        type: 'object',
        properties: {
          block_id: { type: 'string', description: '块 ID' },
          key: { type: 'string', description: 'entry key' },
          body: { type: 'string', description: 'notebook 正文' },
          title: { type: 'string', description: 'notebook 标题' },
          tags: { type: 'string', description: 'notebook 标签，逗号或换行分隔' },
          kind: { type: 'string', description: 'keychain：cookie / token / api_key' },
          value: { type: 'string', description: 'keychain 明文或 notebook body 别名' },
        },
        required: ['block_id', 'key'],
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
];

function requireStore(ctx: OuterToolContext): MemoryBlockStore | null {
  return ctx.memoryBlockStore ?? null;
}

function parseStrategy(raw: unknown): BlockStrategyId {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (s === 'kv_secret' || s === 'notebook') return s;
  return 'notebook';
}

export async function execMemoryBlockList(ctx: OuterToolContext): Promise<ToolCallResult> {
  const store = requireStore(ctx);
  if (!store) return { replied: false, output: '（Memory Block 未启用）' };
  const blocks = store.listBlocks();
  const lines = blocks.map((b) => {
    const sys = b.system ? ' [system]' : '';
    const title = b.title ? ` "${b.title}"` : '';
    return `- ${b.blockId}${title} (${b.strategy})${sys}: ${b.description}`;
  });
  return { replied: false, output: `Memory Blocks（${blocks.length}）：\n${lines.join('\n')}` };
}

export async function execMemoryBlockCreate(
  args: { block_id?: string; strategy?: string; title?: string; description?: string },
  ctx: OuterToolContext,
): Promise<ToolCallResult> {
  const store = requireStore(ctx);
  if (!store) return { replied: false, output: '（Memory Block 未启用）' };
  const blockId = args.block_id?.trim() ?? '';
  if (!blockId) return { replied: false, output: '（block_id 为空）' };
  try {
    const block = await store.createBlock(
      blockId,
      parseStrategy(args.strategy),
      { title: args.title, description: args.description },
      ctx.agentSid,
    );
    return {
      replied: false,
      output: `已创建块 ${block.blockId}（${block.strategy}）。\n${JSON.stringify(block, null, 2)}`,
    };
  } catch (e) {
    return { replied: false, output: `（错误：${e instanceof Error ? e.message : String(e)}）` };
  }
}

export async function execMemoryBlockUpdate(
  args: { block_id?: string; title?: string; description?: string },
  ctx: OuterToolContext,
): Promise<ToolCallResult> {
  const store = requireStore(ctx);
  if (!store) return { replied: false, output: '（Memory Block 未启用）' };
  const blockId = args.block_id?.trim() ?? '';
  if (!blockId) return { replied: false, output: '（block_id 为空）' };
  try {
    const block = await store.updateBlock(blockId, {
      title: args.title,
      description: args.description,
    });
    return { replied: false, output: `已更新块 ${block.blockId}。\n${JSON.stringify(block, null, 2)}` };
  } catch (e) {
    return { replied: false, output: `（错误：${e instanceof Error ? e.message : String(e)}）` };
  }
}

export async function execMemoryBlockDeleteBlock(
  args: { block_id?: string },
  ctx: OuterToolContext,
): Promise<ToolCallResult> {
  const store = requireStore(ctx);
  if (!store) return { replied: false, output: '（Memory Block 未启用）' };
  const blockId = args.block_id?.trim() ?? '';
  if (!blockId) return { replied: false, output: '（block_id 为空）' };
  try {
    const ok = await store.deleteBlock(blockId);
    return { replied: false, output: ok ? `已删除块 ${blockId} 及全部条目` : `（块 ${blockId} 不存在）` };
  } catch (e) {
    return { replied: false, output: `（错误：${e instanceof Error ? e.message : String(e)}）` };
  }
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
  args: {
    block_id?: string;
    key?: string;
    body?: string;
    title?: string;
    tags?: string;
    kind?: string;
    value?: string;
  },
  ctx: OuterToolContext,
): Promise<ToolCallResult> {
  const store = requireStore(ctx);
  if (!store) return { replied: false, output: '（Memory Block 未启用）' };
  const blockId = args.block_id?.trim() ?? '';
  const key = args.key?.trim() ?? '';
  if (!blockId || !key) return { replied: false, output: '（block_id 或 key 为空）' };
  try {
    const block = store.resolveBlock(blockId);
    const content =
      block.strategy === 'notebook'
        ? String(args.body ?? args.value ?? '').trim()
        : String(args.value ?? args.body ?? '').trim();
    if (!content) return { replied: false, output: '（body/value 为空）' };
    const payload: Record<string, unknown> =
      block.strategy === 'notebook'
        ? { body: content, title: args.title, tags: args.tags }
        : { kind: args.kind ?? 'generic', value: content };
    const meta = await store.put(blockId, key, payload, ctx.agentSid);
    return {
      replied: false,
      output: `已写入 ${blockId}/${key}（${block.strategy}）。\n${JSON.stringify(meta, null, 2)}`,
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
    const ok = await store.deleteEntry(blockId, key);
    return { replied: false, output: ok ? `已删除 ${blockId}/${key}` : `（${blockId}/${key} 不存在）` };
  } catch (e) {
    return { replied: false, output: `（错误：${e instanceof Error ? e.message : String(e)}）` };
  }
}

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

export async function dispatchMemoryBlockTool(
  name: string,
  args: Record<string, unknown>,
  ctx: OuterToolContext,
): Promise<ToolCallResult | null> {
  switch (name) {
    case 'memory_block_list':
      return execMemoryBlockList(ctx);
    case 'memory_block_create':
      return execMemoryBlockCreate(
        args as { block_id?: string; strategy?: string; title?: string; description?: string },
        ctx,
      );
    case 'memory_block_update':
      return execMemoryBlockUpdate(
        args as { block_id?: string; title?: string; description?: string },
        ctx,
      );
    case 'memory_block_delete_block':
      return execMemoryBlockDeleteBlock(args as { block_id?: string }, ctx);
    case 'memory_block_entries':
      return execMemoryBlockEntries(args as { block_id?: string }, ctx);
    case 'memory_block_get':
      return execMemoryBlockGet(args as { block_id?: string; key?: string }, ctx);
    case 'memory_block_put':
      return execMemoryBlockPut(
        args as {
          block_id?: string;
          key?: string;
          body?: string;
          title?: string;
          tags?: string;
          kind?: string;
          value?: string;
        },
        ctx,
      );
    case 'memory_block_delete':
      return execMemoryBlockDelete(args as { block_id?: string; key?: string }, ctx);
    case 'keychain_put':
      return execKeychainPut(args as { key?: string; kind?: string; value?: string }, ctx);
    case 'keychain_entries':
      return execKeychainEntries(ctx);
    default:
      return null;
  }
}

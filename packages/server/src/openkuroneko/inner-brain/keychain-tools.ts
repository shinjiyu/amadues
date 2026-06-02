/**
 * 内脑 keychain 只读工具（兜底）— 读 DATA_ROOT/vault/blocks/keychain。
 *
 * 主路径：外脑 set_goal 与 Designer instruction 已带明文凭据；仅 instruction 明确要求读 vault 时用本工具。
 *
 * ADL：doc/structurizr/DYFLOW-INNER-EXECUTOR.md §6.1c · MEMORY-BLOCKS.md §4
 */

import { MemoryBlockStore } from '../../outer/memory-block-store.js';
import type { Tool } from '../tools/index.js';

function resolveDataRoot(explicit?: string): string | null {
  const v = explicit?.trim() || process.env['UTLRA_DATA_ROOT']?.trim();
  return v || null;
}

function resolveAgentId(): string {
  return (
    process.env['UTLRA_AGENT_NAME']?.trim() ||
    process.env['UTLRA_AGENT_IM_SID']?.trim() ||
    'default'
  );
}

function storeFor(dataRoot?: string): MemoryBlockStore | null {
  const root = resolveDataRoot(dataRoot);
  if (!root) return null;
  return new MemoryBlockStore({ dataRoot: root, agentId: resolveAgentId() });
}

export interface KeychainToolsOptions {
  dataRoot?: string;
}

export function createKeychainTools(opts: KeychainToolsOptions = {}): Tool[] {
  const noVault = () => ({
    ok: false as const,
    output: 'keychain: UTLRA_DATA_ROOT 未设置，vault 不可用',
  });

  return [
    {
      name: 'keychain_entries',
      description:
        '【兜底】列出 vault keychain 的 entry key。默认应使用 instruction/goal 中的明文凭据；勿作为读密码的第一步。',
      parameters: {},
      async call() {
        const store = storeFor(opts.dataRoot);
        if (!store) return noVault();
        try {
          const keys = await store.listEntryKeys('keychain');
          if (keys.length === 0) {
            return { ok: true, output: 'keychain: （无条目）' };
          }
          return { ok: true, output: `keychain keys（${keys.length}）：\n${keys.join('\n')}` };
        } catch (e) {
          return { ok: false, output: `keychain_entries: ${e instanceof Error ? e.message : String(e)}` };
        }
      },
    },
    {
      name: 'keychain_get',
      description:
        '【兜底】读取 vault keychain 单条明文。仅当 instruction 明确要求从 vault 某 key 读取且 goal 未提供明文时使用。',
      parameters: {
        key: { type: 'string', description: 'entry key' },
      },
      required: ['key'],
      async call(args) {
        const key = String(args['key'] ?? '').trim();
        if (!key) return { ok: false, output: 'keychain_get: key 必填' };
        const store = storeFor(opts.dataRoot);
        if (!store) return noVault();
        try {
          const meta = await store.get('keychain', key, { includeValue: true });
          if (!meta) return { ok: false, output: `keychain: key "${key}" 不存在` };
          return { ok: true, output: JSON.stringify(meta, null, 2) };
        } catch (e) {
          return { ok: false, output: `keychain_get: ${e instanceof Error ? e.message : String(e)}` };
        }
      },
    },
  ];
}

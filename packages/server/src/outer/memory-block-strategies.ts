/**
 * @see doc/structurizr/MEMORY-BLOCKS.md §3
 */

export type BlockStrategyId = 'kv_secret' | 'notebook' | 'kv_contact' | 'record_ledger';

export interface KvSecretEntry {
  key: string;
  kind: string;
  value: string;
  updated_at: string;
  updated_by: string;
}

export interface NotebookEntry {
  key: string;
  title: string;
  body: string;
  tags: string[];
  updated_at: string;
  updated_by: string;
}

export interface BlockDefinition {
  blockId: string;
  strategy: BlockStrategyId;
  description: string;
  title?: string;
  /** 系统预置块（如 keychain），不可删除 */
  system?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface BlockStrategy<TEntry = unknown> {
  readonly id: BlockStrategyId;
  /** 外脑 list/get 默认是否隐藏敏感字段 */
  readonly redactInOuterPrompt: boolean;
  normalizePut(key: string, payload: Record<string, unknown>, updatedBy: string): TEntry;
  toPublicMeta(entry: TEntry, redactSecrets: boolean): Record<string, unknown>;
}

export const SYSTEM_BLOCK_IDS = ['keychain'] as const;

function requireString(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`memory_block: ${field} must be a non-empty string`);
  return v.trim();
}

function optionalString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function parseTags(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean);
  }
  if (typeof v === 'string' && v.trim()) {
    return v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

export const kvSecretStrategy: BlockStrategy<KvSecretEntry> = {
  id: 'kv_secret',
  redactInOuterPrompt: false,
  normalizePut(key, payload, updatedBy) {
    return {
      key,
      kind: requireString(payload.kind ?? 'generic', 'kind'),
      value: requireString(payload.value ?? payload.body, 'value'),
      updated_at: new Date().toISOString(),
      updated_by: updatedBy,
    };
  },
  toPublicMeta(entry, redactSecrets) {
    const base = {
      key: entry.key,
      kind: entry.kind,
      updated_at: entry.updated_at,
      updated_by: entry.updated_by,
    };
    if (redactSecrets) return base;
    return { ...base, value: entry.value };
  },
};

export const notebookStrategy: BlockStrategy<NotebookEntry> = {
  id: 'notebook',
  redactInOuterPrompt: false,
  normalizePut(key, payload, updatedBy) {
    const body = requireString(payload.body ?? payload.value, 'body');
    return {
      key,
      title: optionalString(payload.title) ?? key,
      body,
      tags: parseTags(payload.tags),
      updated_at: new Date().toISOString(),
      updated_by: updatedBy,
    };
  },
  toPublicMeta(entry, redactSecrets) {
    if (redactSecrets) {
      return {
        key: entry.key,
        title: entry.title,
        updated_at: entry.updated_at,
        updated_by: entry.updated_by,
        body_length: entry.body.length,
      };
    }
    return { ...entry };
  },
};

/** Prevent path traversal in entry filenames */
export function pathSafeKey(key: string): string {
  const safe = key.replace(/[/\\]/g, '_').replace(/\.\./g, '_').trim();
  if (!safe) throw new Error('memory_block: invalid key');
  return safe;
}

/** Block id: 字母数字、下划线、连字符，1–64 字符 */
export function pathSafeBlockId(blockId: string): string {
  const safe = blockId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  if (!safe || safe.length > 64) throw new Error('memory_block: invalid block_id');
  if (safe === '.' || safe === '..') throw new Error('memory_block: invalid block_id');
  return safe;
}

export function isSystemBlockId(blockId: string): boolean {
  return (SYSTEM_BLOCK_IDS as readonly string[]).includes(blockId);
}

const SYSTEM_BLOCKS: BlockDefinition[] = [
  {
    blockId: 'keychain',
    strategy: 'kv_secret',
    description:
      '长期凭据独立保管（Cookie/Token/账号密码）；外脑 set_goal 时明文写入 goal，非加密传输信道',
    title: '钥匙串',
    system: true,
  },
];

export function getSystemBlocks(): BlockDefinition[] {
  return SYSTEM_BLOCKS.map((b) => ({ ...b }));
}

export function resolveStrategy(strategyId: BlockStrategyId): BlockStrategy {
  switch (strategyId) {
    case 'kv_secret':
      return kvSecretStrategy;
    case 'notebook':
      return notebookStrategy;
    default:
      throw new Error(`memory_block: unsupported strategy ${strategyId}`);
  }
}

export function isSupportedCreateStrategy(strategy: string): strategy is BlockStrategyId {
  return strategy === 'notebook' || strategy === 'kv_secret';
}

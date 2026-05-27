/**
 * @see doc/structurizr/MEMORY-BLOCKS.md §3
 */

export type BlockStrategyId = 'kv_secret' | 'kv_contact' | 'record_ledger';

export interface KvSecretEntry {
  key: string;
  kind: string;
  value: string;
  updated_at: string;
  updated_by: string;
}

export interface BlockDefinition {
  blockId: string;
  strategy: BlockStrategyId;
  description: string;
}

export interface BlockStrategy<TEntry = unknown> {
  readonly id: BlockStrategyId;
  normalizePut(key: string, payload: Record<string, unknown>, updatedBy: string): TEntry;
  /** Outer prompt / list: never expose secret values when redactSecrets=true */
  toPublicMeta(entry: TEntry, redactSecrets: boolean): Record<string, unknown>;
  bindRelativePath(key: string): string;
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`memory_block: ${field} must be a non-empty string`);
  return v.trim();
}

export const kvSecretStrategy: BlockStrategy<KvSecretEntry> = {
  id: 'kv_secret',
  normalizePut(key, payload, updatedBy) {
    return {
      key,
      kind: requireString(payload.kind ?? 'generic', 'kind'),
      value: requireString(payload.value, 'value'),
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
  bindRelativePath(key) {
    return pathSafeKey(key) + '.json';
  },
};

/** Prevent path traversal in bind filenames */
export function pathSafeKey(key: string): string {
  const safe = key.replace(/[/\\]/g, '_').replace(/\.\./g, '_');
  if (!safe) throw new Error('memory_block: invalid key');
  return safe;
}

const DEFAULT_BLOCKS: BlockDefinition[] = [
  {
    blockId: 'keychain',
    strategy: 'kv_secret',
    description: 'Credentials (Cookie, Token, API keys); values never in outer prompt',
  },
];

export function getDefaultBlockRegistry(): BlockDefinition[] {
  return [...DEFAULT_BLOCKS];
}

export function resolveStrategy(strategyId: BlockStrategyId): BlockStrategy {
  switch (strategyId) {
    case 'kv_secret':
      return kvSecretStrategy;
    default:
      throw new Error(`memory_block: unsupported strategy ${strategyId}`);
  }
}

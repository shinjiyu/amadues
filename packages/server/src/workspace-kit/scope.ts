/**
 * Scope — 单机首版：固定 tenant，预留扩展。
 */
export interface ScopeRef {
  tenantId?: string;
  poolId?: string;
  agentId?: string;
  taskInstanceId?: string;
  workDirKey?: string;
  threadId?: string;
}

export interface ResolvedScope {
  ref: ScopeRef;
  storageRoot: string;
  caps: Set<'read' | 'write' | 'append' | 'delete'>;
}

export function resolveScopeLocal(dataRoot: string, ref: ScopeRef): ResolvedScope {
  const tenant = ref.tenantId ?? 'default';
  const root = `${dataRoot}/tenants/${tenant}`;
  return {
    ref: { ...ref, tenantId: tenant },
    storageRoot: root,
    caps: new Set(['read', 'write', 'append', 'delete']),
  };
}

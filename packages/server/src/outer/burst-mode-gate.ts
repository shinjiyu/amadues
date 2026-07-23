/**
 * BurstMode gate — explore (default) vs execute (+ workflowRef).
 * @see doc/structurizr/EXECUTABLE-WORKFLOW.md §5
 */
import type { ExecutableWorkflowStore } from './executable-workflow-store.js';
import type { BurstMode, WorkflowRef } from './executable-workflow-types.js';

export interface BurstModeGateInput {
  burstMode?: BurstMode | string | null;
  workflowRef?: WorkflowRef | null;
  /** 可选：校验 ref 是否存在且未 pause */
  store?: ExecutableWorkflowStore;
}

export type BurstModeGateResult =
  | { ok: true; burstMode: BurstMode; workflowRef?: WorkflowRef }
  | { ok: false; error: string };

export function normalizeBurstMode(raw: unknown): BurstMode {
  if (raw === 'execute') return 'execute';
  return 'explore';
}

/**
 * execute 必填 workflowRef；可选校验 store 中存在。
 * explore 忽略 workflowRef（可带但不强制）。
 */
export function gateBurstMode(input: BurstModeGateInput): BurstModeGateResult {
  const burstMode = normalizeBurstMode(input.burstMode);
  if (burstMode === 'explore') {
    return {
      ok: true,
      burstMode: 'explore',
      workflowRef: input.workflowRef ?? undefined,
    };
  }

  const ref = input.workflowRef;
  if (!ref?.id?.trim() || !ref?.version?.trim()) {
    return {
      ok: false,
      error: 'burstMode=execute 需要 workflowRef={ id, version }',
    };
  }

  const workflowRef: WorkflowRef = {
    id: ref.id.trim(),
    version: String(ref.version).trim(),
  };

  if (input.store) {
    const meta = input.store.getMeta(workflowRef.id);
    if (!meta) {
      return { ok: false, error: `workflow 不存在: ${workflowRef.id}` };
    }
    if (meta.paused) {
      return { ok: false, error: `workflow 已暂停: ${workflowRef.id}` };
    }
    const wf = input.store.get(workflowRef);
    if (!wf) {
      return {
        ok: false,
        error: `workflow 版本不存在: ${workflowRef.id}@${workflowRef.version}`,
      };
    }
  }

  return { ok: true, burstMode: 'execute', workflowRef };
}

/** Designer / runner：execute 下禁止 redesign */
export function isRedesignAllowed(burstMode: BurstMode): boolean {
  return burstMode !== 'execute';
}

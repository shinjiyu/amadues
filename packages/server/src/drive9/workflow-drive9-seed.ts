/**
 * drive9 `/workflows/shared/` → 本地 ExecutableWorkflowStore 下拉（P3）
 * @see doc/structurizr/EXECUTABLE-WORKFLOW.md
 */
import type { ExecutableWorkflowStore } from '../outer/executable-workflow-store.js';
import type { ExecutableWorkflow, WorkflowRef } from '../outer/executable-workflow-types.js';
import type { WorkflowDrive9Store } from './workflow-drive9-store.js';

export interface SeedWorkflowsResult {
  imported: number;
  skipped: number;
  errors: number;
}

/**
 * listShared → getShared → 本地 put（版本已存在则跳过，遵守不可变）。
 */
export async function seedWorkflowsFromDrive9(
  remote: WorkflowDrive9Store,
  local: ExecutableWorkflowStore,
  opts?: { limit?: number },
): Promise<SeedWorkflowsResult> {
  const listed = await remote.listShared(opts?.limit ?? 100);
  let imported = 0;
  let skipped = 0;
  let errors = 0;
  for (const entry of listed) {
    if (local.get({ id: entry.id, version: entry.version })) {
      skipped += 1;
      continue;
    }
    try {
      const wf = await remote.getShared(entry.id, entry.version);
      if (!wf) {
        errors += 1;
        continue;
      }
      local.put(wf);
      imported += 1;
    } catch {
      errors += 1;
    }
  }
  return { imported, skipped, errors };
}

/**
 * 本地优先；缺失时从 drive9 pull 并写入本地。
 */
export async function resolveWorkflowWithDrive9(
  local: ExecutableWorkflowStore,
  ref: WorkflowRef,
  remote?: WorkflowDrive9Store | null,
): Promise<ExecutableWorkflow | null> {
  const hit = local.get(ref);
  if (hit) return hit;
  if (!remote) return null;
  const wf = await remote.getShared(ref.id, ref.version);
  if (!wf) return null;
  try {
    local.put(wf);
  } catch {
    // 并发写入同 version 时忽略
  }
  return local.get(ref) ?? wf;
}

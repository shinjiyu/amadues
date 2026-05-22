/**
 * 外脑 ↔ 内脑 **正式生命周期**：何时视为任务完成、是否晋升、如何关闭（与 Dashboard 调试按钮解耦）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  FilesystemRepositoryStore,
  FilesystemWorkspaceStore,
  InnerBrainEngine,
} from '../workspace-kit/index.js';
import { promoteWorkspaceManifestToRepository } from '../repository/promote-from-workspace.js';

/** burst 结束后是否自动「manifest 晋升 → 内脑休眠」 */
export type AfterBurstPolicy = 'none' | 'promote_and_shutdown_if_complete';

const ENV_KEY = 'UTLRA_OUTER_AFTER_BURST';

export function resolveAfterBurstPolicy(
  override?: AfterBurstPolicy | 'inherit',
): AfterBurstPolicy {
  if (override && override !== 'inherit') return override;
  const raw = process.env[ENV_KEY]?.trim().toLowerCase();
  if (raw === 'promote_and_shutdown_if_complete' || raw === '1' || raw === 'true') {
    return 'promote_and_shutdown_if_complete';
  }
  return 'none';
}

/**
 * 与 pi-tick / pi-auto 的 `suggestPromoteShutdown` 一致：BLOCKED 且 blockedReason 含「目标已完成」。
 */
export function suggestGoalCompleteForShutdown(workDir: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(workDir, '.brain', 'controller-state.json'), 'utf8');
    const cs = JSON.parse(raw) as { mode?: string; blockedReason?: string | null };
    return (
      cs.mode === 'BLOCKED' && String(cs.blockedReason ?? '').includes('目标已完成')
    );
  } catch {
    return false;
  }
}

export interface PromoteThenShutdownResult {
  promoted: { added: number; skipped: string[] };
  status: ReturnType<InnerBrainEngine['brainShutdown']>;
}

/** 正式收尾：manifest → Repository（执行轨）→ brainShutdown（SLEEPING） */
export function runPromoteThenShutdown(
  repo: FilesystemRepositoryStore,
  workspaceStore: FilesystemWorkspaceStore,
  engine: InnerBrainEngine,
  workspaceId: string,
  opts?: { tenantId?: string; realm?: string; sessionId?: string },
): PromoteThenShutdownResult {
  workspaceStore.ensureWorkspace(workspaceId);
  const tenant = opts?.tenantId?.trim() || 'default';
  const realm = opts?.realm?.trim() || `workspace:${workspaceId}`;
  const sessionId = opts?.sessionId?.trim() || `promote-${Date.now()}`;
  const pr = promoteWorkspaceManifestToRepository(repo, workspaceStore, tenant, workspaceId, {
    realm,
    sessionId,
    lane: 'execution',
  });
  const status = engine.brainShutdown();
  return { promoted: { added: pr.added, skipped: pr.skipped }, status };
}

/**
 * Ops / E2E：HTTP 直连 KPI 推进，绕过外脑 LLM。
 *
 * ADL：doc/structurizr/KPI-ADVANCEMENT.md · KPI-CLOSED-LOOP.md §API dispatch
 */
import type { ChatAssetStore, ChatIRChannel } from '@utlra/chat-ir';
import type {
  FilesystemRepositoryStore,
  FilesystemWorkspaceStore,
  InnerBrainEngine,
} from '../workspace-kit/index.js';
import type { SkillDrive9Store } from '../drive9/skill-drive9-store.js';
import type { KnowledgeDrive9Store } from '../drive9/knowledge-drive9-store.js';
import type { SkillMemoryStore } from '../mem9/skill-memory-store.js';
import type { InnerBrainRegistry } from './inner-brain-registry.js';
import type { KpiRegistry } from './kpi-registry.js';
import { evaluateKpiAutonomyDispatch } from './kpi-dispatch-guard.js';
import { advanceKpi } from './kpi/kpi-advancer.js';
import {
  resolveAgentSid,
  resolveWorkspaceId,
  type OuterToolContext,
} from './outer-tools.js';
import type { OuterMemoryStore } from './outer-memory.js';

export interface KpiApiDispatchDeps {
  dataRoot: string;
  repoRoot: string;
  innerBrainRegistry: InnerBrainRegistry;
  kpiRegistry: KpiRegistry;
  assetStore: ChatAssetStore;
  getEngine: (workspaceId: string) => InnerBrainEngine;
  workspaceStore: FilesystemWorkspaceStore;
  repoStore: FilesystemRepositoryStore;
  imClient?: ChatIRChannel | null;
  memoryStore?: OuterMemoryStore | null;
  skillStore?: SkillMemoryStore;
  skillDrive9Store?: SkillDrive9Store;
  knowledgeDrive9Store?: KnowledgeDrive9Store;
  defaultThreadId?: string;
  agentSid?: string;
  workspaceId?: string;
}

export interface KpiApiDispatchInput {
  goal?: string;
  origin_thread?: string;
  origin_user?: string;
}

export interface KpiApiDispatchResult {
  ok: boolean;
  output: string;
  instanceId?: string;
  reason?: string;
}

function buildToolCtx(deps: KpiApiDispatchDeps, threadId: string): OuterToolContext {
  return {
    threadId,
    agentSid: deps.agentSid ?? resolveAgentSid(),
    workspaceId: deps.workspaceId ?? resolveWorkspaceId(),
    repoRoot: deps.repoRoot,
    imClient: (deps.imClient ?? { start() {}, destroy() {}, postMessage: async () => {} }) as ChatIRChannel,
    assetStore: deps.assetStore,
    getEngine: deps.getEngine,
    workspaceStore: deps.workspaceStore,
    repoStore: deps.repoStore,
    dataRoot: deps.dataRoot,
    innerBrainRegistry: deps.innerBrainRegistry,
    kpiRegistry: deps.kpiRegistry,
    memoryStore: deps.memoryStore ?? undefined,
    skillStore: deps.skillStore,
    skillDrive9Store: deps.skillDrive9Store,
    knowledgeDrive9Store: deps.knowledgeDrive9Store,
    allowKpiSetGoal: true,
  };
}

/**
 * 为 active KPI 推进一发内脑 burst（kpiAdvancer）。
 */
export async function dispatchKpiBurst(
  deps: KpiApiDispatchDeps,
  kpiId: string,
  input: KpiApiDispatchInput = {},
): Promise<KpiApiDispatchResult> {
  const kpi = deps.kpiRegistry.get(kpiId);
  if (!kpi) {
    return { ok: false, output: '', reason: 'kpi_not_found' };
  }
  if (kpi.status !== 'active') {
    return { ok: false, output: '', reason: `kpi_status_${kpi.status}` };
  }

  const decision = evaluateKpiAutonomyDispatch(
    deps.kpiRegistry,
    deps.innerBrainRegistry,
    kpiId,
  );
  if (!decision.ok) {
    return { ok: false, output: '', reason: decision.reason };
  }

  const charter = (input.goal?.trim() || kpi.charter || kpi.description).trim();
  if (!charter) {
    return { ok: false, output: '', reason: 'goal_empty' };
  }

  const threadId =
    input.origin_thread?.trim() ||
    deps.defaultThreadId?.trim() ||
    process.env['UTLRA_OUTER_HEARTBEAT_THREAD_ID']?.trim() ||
    'thread:ops';

  deps.kpiRegistry.update(kpiId, { charter });

  const adv = await advanceKpi(
    {
      kpiRegistry: deps.kpiRegistry,
      innerBrainRegistry: deps.innerBrainRegistry,
      toolCtx: buildToolCtx(deps, threadId),
      workspaceId: deps.workspaceId ?? resolveWorkspaceId(),
      defaultThreadId: threadId,
    },
    kpiId,
  );

  if (!adv.ok) {
    return { ok: false, output: adv.detail ?? '', reason: adv.reason };
  }

  return {
    ok: true,
    output: `KPI 推进：${adv.reason}${adv.instanceId ? ` instance_id=${adv.instanceId}` : ''}`,
    instanceId: adv.instanceId,
  };
}

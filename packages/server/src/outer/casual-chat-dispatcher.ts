/**
 * idle 心跳下的 proactive IM 闲聊（概率 + 频控）。
 * KPI 派遣由 kpiManager.tick 负责；本模块不 spawn 内脑。
 */
import type { ChatIRChannel } from '@utlra/chat-ir';
import type { IdentityRegistry, LooseThreadStore } from '@utlra/chat-ir';
import type { InnerLlmEnv } from '../llm/inner-llm-step.js';
import { llmRawChatCompletion } from '../llm/raw.js';
import { loadInboundConfigFromEnv } from './inbound-policy.js';
import { getGroupParticipationState, recordProactiveSpeak } from './participation-state.js';
import type { KpiRegistry, KpiRecord } from './kpi-registry.js';
import { selectKpiByMomentum } from './kpi-feedback.js';
import type { InnerBrainRegistry } from './inner-brain-registry.js';
import type { OuterToolContext } from './outer-tools.js';
import { loadSoul } from './soul.js';
import {
  loadAutonomyPolicy,
  markAutonomousAction,
} from './autonomy-policy-store.js';
import { loadPersonality } from './personality.js';
import { logAutonomyDispatch } from './autonomy-action-log.js';
import { findLiveBurstForKpi, isKpiSprintInProgress } from './kpi-dispatch-guard.js';
import type { InnerBrainEngine } from '../workspace-kit/index.js';
import type { OuterMemoryStore } from './outer-memory.js';
import { formatRecentThreadMessagesForLlm } from './thread-history.js';
import {
  isTaskOnCooldown,
  isTaskOverDailyLimit,
  recordTaskDispatch,
} from './autonomy-task-state.js';
import type {
  AgentPersonality,
  AutonomyDispatchResult,
  AutonomyPolicy,
  AutonomyTaskType,
  AutonomyVerdict,
  ResourceSnapshot,
} from './autonomy-types.js';

export interface CasualChatDispatchDeps {
  dataRoot: string;
  agentSid: string;
  workspaceId: string;
  defaultThreadId: string;
  registry: InnerBrainRegistry;
  kpiRegistry: KpiRegistry;
  imClient: ChatIRChannel | null;
  toolCtx: OuterToolContext;
  getLlmEnv: () => InnerLlmEnv | null;
  getEngine?: (workspaceId: string) => InnerBrainEngine;
  memoryStore?: OuterMemoryStore;
  loadThreads?: () => LooseThreadStore;
  identityRegistry?: IdentityRegistry;
}

function taskConfig(policy: AutonomyPolicy, id: AutonomyTaskType) {
  return policy.taskTypes[id] ?? { enabled: false, cooldownMs: 0, maxPerDay: 0 };
}

function pickActiveKpi(kpiRegistry: KpiRegistry): KpiRecord | undefined {
  const active = kpiRegistry.list({ status: 'active' });
  return selectKpiByMomentum(active);
}

function canSpawnInner(snapshot: ResourceSnapshot, _registry: InnerBrainRegistry, policy: AutonomyPolicy): boolean {
  const g = policy.hardGates;
  if (snapshot.innerBrains.running >= g.maxRunningInnerBrains) return false;
  return true;
}

function taskEligible(
  dataRoot: string,
  policy: AutonomyPolicy,
  taskType: AutonomyTaskType,
): { ok: boolean; reason: string } {
  const cfg = taskConfig(policy, taskType);
  if (!cfg.enabled) return { ok: false, reason: `${taskType}_disabled` };
  if (isTaskOnCooldown(dataRoot, taskType, cfg.cooldownMs)) {
    return { ok: false, reason: `${taskType}_cooldown` };
  }
  if (isTaskOverDailyLimit(dataRoot, taskType, cfg.maxPerDay)) {
    return { ok: false, reason: `${taskType}_max_per_day` };
  }
  return { ok: true, reason: 'ok' };
}

function casualChatParticipationOk(threadId: string): { ok: boolean; reason: string } {
  const config = loadInboundConfigFromEnv();
  const state = getGroupParticipationState(threadId);
  const now = Date.now();
  if (now - state.lastProactiveAt < config.speakCooldownMs) {
    return { ok: false, reason: 'participation_cooldown' };
  }
  if (now - state.proactiveCountResetAt > 5 * 60 * 1000) {
    state.proactiveCount5min = 0;
    state.proactiveCountResetAt = now;
  }
  if (state.proactiveCount5min >= config.maxProactivePer5Min) {
    return { ok: false, reason: 'participation_max_5min' };
  }
  return { ok: true, reason: 'ok' };
}

async function draftCasualChatText(
  env: InnerLlmEnv,
  soul: string,
  agentName: string,
  kpiFocusLine: string,
  threadContext: string,
): Promise<string | null> {
  const { raw } = await llmRawChatCompletion<{
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  }>({
    provider: env.provider,
    apiKey: env.apiKey,
    baseUrl: env.baseUrl,
    usageMeta: { source: 'autonomy', model: env.textModel, provider: env.provider },
    body: {
      model: env.textModel,
      temperature: 0.55,
      max_tokens: 160,
      thinking: { type: 'disabled' },
      messages: [
        {
          role: 'system',
          content:
            `${soul}\n\n你是 ${agentName}。外脑空闲时**可能**在 IM 自然接话。\n\n` +
            `## 边界（必须遵守）\n` +
            `- **只管自己的事**：${kpiFocusLine}\n` +
            `- 群聊在讨论**别的 agent** 的任务/内脑/小说/空投/VPS 等，且没 @你 → **只回复 SKIP**，不要插嘴、不要主动帮忙、不要当群管家。\n` +
            `- 不要替别人传文件/cookie、不要汇总他人进度、不要评论别人该怎么干。\n` +
            `- 只有人类 @你、或话题与**你的 KPI** 直接相关时，才考虑发言。\n\n` +
            `## 输出\n` +
            `能自然接话且与**你自己**相关：1-2 句，口语化，无 markdown 列表。\n` +
            `否则只回复一个词：SKIP`,
        },
        {
          role: 'user',
          content:
            `## 当前对话（最近消息）\n\n${threadContext}\n\n` +
            `若无必要接话（尤其是在聊别人的事），回复 SKIP。`,
        },
      ],
    },
  });
  const text = raw.choices?.[0]?.message?.content?.trim() ?? '';
  if (!text || /^SKIP\b/i.test(text)) return null;
  return text;
}

async function executeCasualChat(
  deps: CasualChatDispatchDeps,
  personality: AgentPersonality,
  snapshot: ResourceSnapshot,
  policy: AutonomyPolicy,
): Promise<AutonomyDispatchResult> {
  const focusKpi = pickActiveKpi(deps.kpiRegistry);
  if (focusKpi) {
    const live = findLiveBurstForKpi(deps.registry, focusKpi.kpiId, undefined, deps.kpiRegistry);
    if (live) {
      return { dispatched: false, reason: 'casual_chat_kpi_in_progress' };
    }
    if (canSpawnInner(snapshot, deps.registry, policy)) {
      return { dispatched: false, reason: 'casual_chat_defer_to_kpi' };
    }
  }

  if (!deps.imClient) return { dispatched: false, reason: 'no_im_client' };
  const threadId = deps.defaultThreadId.trim();
  if (!threadId) return { dispatched: false, reason: 'no_default_thread' };

  const part = casualChatParticipationOk(threadId);
  if (!part.ok) return { dispatched: false, reason: part.reason };

  if (!deps.loadThreads || !deps.identityRegistry) {
    return { dispatched: false, reason: 'no_thread_store' };
  }

  const recent = formatRecentThreadMessagesForLlm(
    threadId,
    deps.loadThreads,
    deps.identityRegistry,
  );
  if (recent.messageCount === 0) {
    return { dispatched: false, reason: 'no_thread_context' };
  }
  if (!recent.hasHumanMessage) {
    return { dispatched: false, reason: 'no_human_in_thread' };
  }
  if (recent.lastSenderSid === deps.agentSid) {
    return { dispatched: false, reason: 'agent_spoke_last' };
  }

  if (Math.random() >= personality.idleChatProbability) {
    return { dispatched: false, reason: 'chat_probability_skip', detail: `p=${personality.idleChatProbability}` };
  }

  const env = deps.getLlmEnv();
  if (!env) return { dispatched: false, reason: 'no_llm_env' };

  const agentName = process.env['UTLRA_AGENT_NAME']?.trim() || deps.agentSid;
  const kpiFocusLine = focusKpi
    ? `当前 KPI：${focusKpi.description.slice(0, 120)}。闲聊不得耽误 KPI 推进。`
    : '无 active KPI 时也只接与自己工作相关的话，不管别人闲事。';

  const text = await draftCasualChatText(
    env,
    loadSoul(deps.dataRoot),
    agentName,
    kpiFocusLine,
    recent.text,
  );
  if (!text) return { dispatched: false, reason: 'chat_draft_failed' };

  try {
    await deps.imClient.postMessage(threadId, {
      sender_sid: deps.agentSid,
      text,
      parse_mentions: true,
    });
    recordProactiveSpeak(threadId);
    return { dispatched: true, taskType: 'casual_chat', reason: 'casual_chat', detail: text.slice(0, 120) };
  } catch (e) {
    return {
      dispatched: false,
      reason: 'post_failed',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function dispatchCasualChat(
  deps: CasualChatDispatchDeps,
  snapshot: ResourceSnapshot,
  verdict: AutonomyVerdict,
): Promise<AutonomyDispatchResult> {
  if (verdict.level !== 'idle') {
    return { dispatched: false, reason: verdict.blockedByHardGate ?? 'busy' };
  }

  const policy = loadAutonomyPolicy(deps.dataRoot);
  const personality = loadPersonality(deps.dataRoot);

  if (isKpiSprintInProgress(deps.registry, deps.kpiRegistry)) {
    const result: AutonomyDispatchResult = {
      dispatched: false,
      reason: 'kpi_sprint_in_progress',
    };
    logAutonomyDispatch(deps.dataRoot, snapshot, result);
    return result;
  }

  const chatElig = taskEligible(deps.dataRoot, policy, 'casual_chat');
  if (!chatElig.ok) {
    const result: AutonomyDispatchResult = { dispatched: false, reason: chatElig.reason };
    logAutonomyDispatch(deps.dataRoot, snapshot, result);
    return result;
  }

  const result = await executeCasualChat(deps, personality, snapshot, policy);
  logAutonomyDispatch(deps.dataRoot, snapshot, result);
  if (result.dispatched) {
    recordTaskDispatch(deps.dataRoot, 'casual_chat');
    markAutonomousAction(deps.dataRoot);
  }
  return result;
}

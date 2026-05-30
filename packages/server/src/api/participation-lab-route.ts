import type { Hono } from 'hono';
import { llmChatCompletion } from '../llm/client.js';
import {
  decideOuterShouldReply,
  loadInboundConfigFromEnv,
  participationSpeakLlm,
  shouldReplySyncRules,
  type InboundConfig,
  type LlmChatFn,
  type OuterInboundMeta,
  type ParticipationAgentContext,
} from '../outer/inbound-policy.js';
import { resetGroupParticipationState } from '../outer/participation-state.js';
import { loadInnerLlmEnvFromProcess } from '../llm/inner-llm-step.js';
import { PARTICIPATION_LAB_PRESETS, type ParticipationLabCase } from './participation-lab-presets.js';

export interface ParticipationEvaluateBody {
  threadId: string;
  content: string;
  meta: OuterInboundMeta;
  proactiveLevel: number;
  threadHistoryPrefix?: string;
  innerStatusSummary?: string;
  agentContext?: ParticipationAgentContext;
  config?: Partial<InboundConfig>;
  /**
   * @deprecated 由 llmMode 决定：none=仅同步；mock/real=Lab 强制调 LLM
   */
  mode?: 'sync-only' | 'full';
  /** none=仅同步规则；mock/real=**必定**调用 participationSpeakLlm，final 以 LLM 为准 */
  llmMode?: 'mock' | 'real' | 'none';
  mockLlmContent?: string;
  resetThreadState?: boolean;
}

function mergeConfig(partial?: Partial<InboundConfig>): InboundConfig {
  const base = loadInboundConfigFromEnv();
  if (!partial) return base;
  return {
    proactiveLevel: partial.proactiveLevel ?? base.proactiveLevel,
    speakCooldownMs: partial.speakCooldownMs ?? base.speakCooldownMs,
    maxProactivePer5Min: partial.maxProactivePer5Min ?? base.maxProactivePer5Min,
    useLlmForParticipation: partial.useLlmForParticipation ?? base.useLlmForParticipation,
  };
}

function buildMockLlmChat(content: string): LlmChatFn {
  return async () => ({ content, raw: {} as Record<string, unknown> });
}

function resolveLlmMode(body: ParticipationEvaluateBody): 'mock' | 'real' | 'none' {
  if (body.llmMode) return body.llmMode;
  if (body.mockLlmContent) return 'mock';
  if (body.mode === 'sync-only') return 'none';
  return 'none';
}

function setupLabLlm(
  llmMode: 'mock' | 'real',
  mockLlmContent: string | undefined,
): { llmEnv: NonNullable<ReturnType<typeof loadInnerLlmEnvFromProcess>>; llmChat: LlmChatFn; llmRawSeed: string | null } {
  if (llmMode === 'mock') {
    const mock = (mockLlmContent ?? 'SILENT').trim();
    let llmEnv = loadInnerLlmEnvFromProcess();
    if (!llmEnv) {
      llmEnv = {
        provider: 'kimi',
        apiKey: 'lab-mock',
        baseUrl: 'https://example.test',
        textModel: 'mock',
        visionModel: 'mock',
        maxTokensText: 256,
        maxTokensMultimodal: 256,
        thinking: 'disabled',
      };
    }
    return { llmEnv, llmChat: buildMockLlmChat(mock), llmRawSeed: mock };
  }

  const llmEnv = loadInnerLlmEnvFromProcess();
  if (!llmEnv) {
    throw new LabEvaluateError('未配置 LLM（.env 缺少 API key），无法使用「真实 LLM」', 400);
  }
  return { llmEnv, llmChat: llmChatCompletion, llmRawSeed: null };
}

class LabEvaluateError extends Error {
  constructor(
    message: string,
    readonly status: 400,
  ) {
    super(message);
  }
}

export async function evaluateParticipation(body: ParticipationEvaluateBody) {
  try {
    const threadId = (body.threadId ?? '').trim() || `participation-lab:${Date.now()}`;
    const content = body.content ?? '';
    const meta = body.meta;
    if (!meta?.threadKind) {
      return { error: 'meta.threadKind is required', status: 400 as const };
    }

    const proactiveLevel = Number(body.proactiveLevel ?? 2);
    const config = mergeConfig(body.config);
    const effectiveLevel = body.config?.proactiveLevel ?? proactiveLevel;
    const llmMode = resolveLlmMode(body);

    if (body.resetThreadState !== false) {
      resetGroupParticipationState(threadId);
    }

    const agentContext: ParticipationAgentContext | undefined = body.agentContext;

    const sync = shouldReplySyncRules(
      { threadId, content, meta, proactiveLevel: effectiveLevel, agentContext },
      config,
    );

    if (llmMode === 'none') {
      return {
        status: 200 as const,
        data: {
          threadId,
          llmMode,
          sync,
          final: sync,
          productionFinal: sync,
          usedLlm: false,
          llmRaw: null,
          path: [`sync → ${sync.reason}`],
          config,
        },
      };
    }

    const { llmEnv, llmChat: baseLlmChat, llmRawSeed } = setupLabLlm(llmMode, body.mockLlmContent);

    let llmRaw = llmRawSeed;
    const capturingChat: LlmChatFn = async (opts) => {
      const out = await baseLlmChat(opts);
      if (llmMode === 'real') llmRaw = out.content;
      return out;
    };

    const labConfig: InboundConfig = {
      ...config,
      useLlmForParticipation: true,
    };

    const speak = await participationSpeakLlm(
      llmEnv,
      {
        content,
        threadHistoryPrefix: body.threadHistoryPrefix ?? '',
        innerStatusSummary: body.innerStatusSummary ?? '',
        proactiveLevel: effectiveLevel,
        agentContext,
      },
      capturingChat,
    );

    const final = {
      shouldReply: speak,
      reason: speak ? 'group_llm_speak' : 'group_llm_silent',
    };

    const productionFinal = await decideOuterShouldReply({
      threadId,
      content,
      meta,
      proactiveLevel: effectiveLevel,
      threadHistoryPrefix: body.threadHistoryPrefix ?? '',
      innerStatusSummary: body.innerStatusSummary ?? '',
      llmEnv,
      llmChat: baseLlmChat,
      config: labConfig,
      agentContext,
    });

    const path: string[] = [
      `sync → ${sync.reason}`,
      `llm (${llmMode}) → ${final.reason}`,
    ];
    if (sync.reason !== 'needs_llm') {
      path.push(
        `生产路径（未强制）→ ${productionFinal.shouldReply ? 'SPEAK' : 'SILENT'} · ${productionFinal.reason}`,
      );
    }

    return {
      status: 200 as const,
      data: {
        threadId,
        llmMode,
        sync,
        final,
        productionFinal,
        usedLlm: true,
        llmRaw,
        path,
        config: labConfig,
      },
    };
  } catch (e) {
    if (e instanceof LabEvaluateError) {
      return { error: e.message, status: e.status };
    }
    throw e;
  }
}

export function registerParticipationLabRoutes(app: Hono): void {
  app.get('/api/dev/participation/presets', (c) => {
    return c.json({ presets: PARTICIPATION_LAB_PRESETS });
  });

  app.post('/api/dev/participation/reset-state', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { threadId?: string };
    resetGroupParticipationState(body.threadId);
    return c.json({ ok: true, cleared: body.threadId ?? '*' });
  });

  app.post('/api/dev/participation/evaluate', async (c) => {
    const body = (await c.req.json()) as ParticipationEvaluateBody;
    const out = await evaluateParticipation(body);
    if ('error' in out) return c.json({ error: out.error }, out.status);
    return c.json(out.data);
  });

  app.post('/api/dev/participation/run-preset/:id', async (c) => {
    const id = c.req.param('id');
    const preset = PARTICIPATION_LAB_PRESETS.find((p) => p.id === id);
    if (!preset) return c.json({ error: 'preset not found' }, 404);
    const useMock = c.req.query('mock') !== '0';
    const out = await evaluateParticipation(presetToEvaluateBody(preset, useMock));
    if ('error' in out) return c.json({ error: out.error }, out.status);
    return c.json({ presetId: id, expect: preset.expect, ...out.data });
  });
}

function presetToEvaluateBody(preset: ParticipationLabCase, useMock: boolean): ParticipationEvaluateBody {
  const wantsLlm =
    preset.category === 'group-llm' || Boolean(preset.mockLlmContent && useMock);

  return {
    threadId: `${preset.threadId}:${Date.now()}`,
    content: preset.content,
    meta: preset.meta,
    proactiveLevel: preset.proactiveLevel,
    threadHistoryPrefix: preset.threadHistoryPrefix,
    innerStatusSummary: preset.innerStatusSummary,
    config: preset.config,
    llmMode: wantsLlm ? 'mock' : 'none',
    mockLlmContent: preset.mockLlmContent,
    resetThreadState: true,
  };
}

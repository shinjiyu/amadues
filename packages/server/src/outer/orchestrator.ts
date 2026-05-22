/**
 * M6 外脑编排：写 thread、设 Goal、子进程跑内脑 burst、读快照拼 StructuredReply（不阻塞热路径）。
 * burst 结束后可按策略执行 **正式收尾**（manifest 晋升 + 关闭内脑），见 `inner-lifecycle.ts`。
 */
import { randomUUID } from 'node:crypto';
import type { FilesystemRepositoryStore, FilesystemWorkspaceStore } from '../workspace-kit/index.js';
import { InnerBrainEngine } from '../workspace-kit/index.js';
import { spawnInnerBrainWorker } from '../pi-mono/inner-brain-spawner.js';
import {
  MessagePartSchema,
  MessageRecordSchema,
  resolvePrimaryAgentSid,
  StructuredReplySchema,
  mergeStructuredReply,
  renderMockChannel,
  serializeIdentityPack,
  validateReplyMentions,
  ensureThreadShell,
  type ChatAssetStore,
  type IdentityRegistry,
  type MessagePart,
  type StructuredReply,
  type LooseThreadStore,
} from '@utlra/chat-ir';
import { expandAttachAssetIds } from './attach-expand.js';
import {
  type AfterBurstPolicy,
  resolveAfterBurstPolicy,
  runPromoteThenShutdown,
  suggestGoalCompleteForShutdown,
} from './inner-lifecycle.js';
import { persistMessagePartsToGoalMarkdown } from './parts-to-goal.js';
import { buildThreadHistoryPrefix, resolveThreadHistoryOpts } from './thread-history.js';
import { enrichGoalMarkdownWithVision } from './goal-vision-enrich.js';
import { draftOuterStructuredReplyPayload } from './outer-reply-llm.js';
import { loadInnerLlmEnvFromProcess } from '../llm/inner-llm-step.js';
import {
  decideOuterShouldReply,
  resolveProactiveLevel,
  type OuterInboundMeta,
} from './inbound-policy.js';

/**
 * `reply.v1` → `MessagePart[]`。
 *
 * 协议：`doc/protocols/inner-brain-deliverables.md` §6 / `doc/chat-ir-identity-design.md` §5.2.1
 *
 * `attach_asset_ids` 是 LLM 引用 asset 的"语法糖"，运行时在这里展开为 attachment parts
 * 追加到 `parts` 末尾（与既有 `parts` 不去重，重复发送由 LLM 自行决策）。
 * 校验失败的 id 静默剔除，记录在 `<dataRoot>/_orphan` 下的 deliverables.log（保持简单）。
 */
function materializeReplyMentionParts(
  reply: StructuredReply,
  registry?: IdentityRegistry,
): MessagePart[] {
  const existing = new Set(
    (reply.parts ?? [])
      .filter((part): part is Extract<MessagePart, { type: 'mention' }> => part.type === 'mention')
      .map((part) => part.target_sid),
  );
  const mentionSids = reply.mention_sids.filter((sid) => !existing.has(sid));
  if (mentionSids.length === 0) return [];

  const parts: MessagePart[] = [];
  for (const sid of mentionSids) {
    if (parts.length > 0) parts.push({ type: 'text', text: ' ' });
    parts.push({
      type: 'mention',
      target_sid: sid,
      label: registry?.get(sid)?.display_name,
    });
  }
  return parts;
}

export function structuredReplyToMessageParts(
  reply: StructuredReply,
  assetStore?: ChatAssetStore,
  logDir?: string,
  registry?: IdentityRegistry,
): MessagePart[] {
  const base: MessagePart[] =
    reply.parts?.length
      ? [...reply.parts]
      : reply.text?.trim()
        ? [{ type: 'text', text: reply.text.trim() }]
        : [];
  const mentionParts = materializeReplyMentionParts(reply, registry);
  const body =
    mentionParts.length === 0
      ? base
      : base.length === 0
        ? mentionParts
        : [...mentionParts, { type: 'text', text: ' ' } as MessagePart, ...base];

  if (!assetStore || !reply.attach_asset_ids?.length) return body;

  const expanded = expandAttachAssetIds(reply.attach_asset_ids, assetStore, { logDir });
  return [...body, ...expanded.parts];
}

/** 将外脑 StructuredReply 落一条主助手消息到 IM 线程，便于 Web 展示 */
function appendAgentReplyToThread(
  deps: {
    loadThreads: () => LooseThreadStore;
    saveThreads: (d: LooseThreadStore) => void;
    assetStore?: ChatAssetStore;
    dataRoot?: string;
    registry?: IdentityRegistry;
  },
  threadId: string,
  reply: StructuredReply,
): void {
  const parts = structuredReplyToMessageParts(reply, deps.assetStore, deps.dataRoot, deps.registry);
  if (parts.length === 0) return;
  const data = deps.loadThreads();
  const list = data.messages[threadId] ?? [];
  const agentMsg = MessageRecordSchema.parse({
    schema: 'message.v1',
    message_id: `msg:${randomUUID()}`,
    thread_id: threadId,
    sender_sid: resolvePrimaryAgentSid(),
    sent_at: new Date().toISOString(),
    parts,
  });
  list.push(agentMsg);
  data.messages[threadId] = list;
  deps.saveThreads(data);
}

function resolveEnrichGoalVision(v?: boolean | 'inherit'): boolean {
  if (v === true) return true;
  if (v === false) return false;
  const x = process.env['UTLRA_GOAL_VISION_ENRICH']?.trim().toLowerCase();
  return x === '1' || x === 'true';
}

function resolveOuterLlmReply(v?: boolean | 'inherit'): boolean {
  if (v === true) return true;
  if (v === false) return false;
  const x = process.env['UTLRA_OUTER_REPLY_LLM']?.trim().toLowerCase();
  return x === '1' || x === 'true';
}

/** 是否执行内脑子进程 burst；默认 true（兼容旧行为）。`UTLRA_OUTER_RUN_INNER=0` 可默认纯聊天不外派任务。 */
function resolveRunInner(v?: boolean | 'inherit'): boolean {
  if (v === true) return true;
  if (v === false) return false;
  const x = process.env['UTLRA_OUTER_RUN_INNER']?.trim().toLowerCase();
  if (x === '0' || x === 'false' || x === 'no') return false;
  return true;
}

export interface OuterRoundtripParams {
  threadId: string;
  /** 与 `messageParts` 二选一（或同时给：以 `messageParts` 为准） */
  userText?: string;
  /** 结构化入站（含 mention / quote / attachment）；会写入 thread 并转为 goal.md */
  messageParts?: MessagePart[];
  workspaceId: string;
  senderSid: string;
  maxTicks?: number;
  /** 覆盖环境变量 `UTLRA_OUTER_AFTER_BURST`；`inherit` 表示读环境 */
  afterBurst?: AfterBurstPolicy | 'inherit';
  tenantId?: string;
  realm?: string;
  /**
   * 将本线程**已落库**消息拼入 goal 前缀；`0` 关闭。
   * 未传则用 `UTLRA_OUTER_THREAD_HISTORY_LIMIT`（默认 30）。
   */
  historyLimit?: number;
  /** 历史块最大字符，未传则用 `UTLRA_OUTER_THREAD_HISTORY_MAX_CHARS`（默认 80000） */
  historyMaxChars?: number;
  /** goal 内 `![](本地路径)` 是否调用视觉模型追加摘要；`inherit` 读 `UTLRA_GOAL_VISION_ENRICH` */
  enrichGoalVision?: boolean | 'inherit';
  /** burst 结束后是否用外脑文本模型改写 StructuredReply；`inherit` 读 `UTLRA_OUTER_REPLY_LLM` */
  outerLlmReply?: boolean | 'inherit';
  /**
   * 会话类型：dm 默认每条参与回复；group 需配合 is_mention / 参与决策（对齐 openKuroneko）。
   * 未传视为 dm（兼容旧客户端）。
   */
  threadKind?: 'dm' | 'group';
  /** 群聊中是否 @ 本 agent；未传时 dm=true，group=false */
  isMentionAgent?: boolean;
  /**
   * 跳过 `appendAgentReplyToThread`（不写 threads.json）。
   * 用于 IM 协议路径：外脑回复由调用方通过 ChatIRChannel.postMessage 发回，
   * 由 IM server 统一落库并广播 WS，保证客户端实时可见。
   */
  skipAppendReply?: boolean;
  /** 群聊中是否 @ 了他人（非只 @ 本 agent） */
  mentionsOthers?: boolean;
  /** 跳过参与决策（调试或 owner 强制回复） */
  skipParticipationCheck?: boolean;
  /** 是否执行内脑 burst（设 goal + inner-worker）；`inherit` 读 `UTLRA_OUTER_RUN_INNER` */
  runInner?: boolean | 'inherit';
  /**
   * IM 等渠道已写入用户消息时置 true：不重复追加；以线程**最后一条**（且与 `senderSid` 一致）为本轮输入。
   */
  userMessagePersisted?: boolean;
}

export interface OuterLifecycleOutcome {
  afterBurstPolicy: AfterBurstPolicy;
  goalCompleteSuggested: boolean;
  /** 仅在策略为 promote_and_shutdown_if_complete 且检测到完成时可能为 true */
  promoteShutdownApplied: boolean;
  promoted?: { added: number; skipped: string[] };
}

export interface OuterRoundtripResult {
  reply: StructuredReply;
  mock: ReturnType<typeof renderMockChannel>;
  innerStatus: Record<string, unknown> | null;
  workerExitCode: number;
  workerStdout: string;
  lifecycle: OuterLifecycleOutcome;
  /** 注入内脑 goal 的 IM 历史摘要 */
  threadHistory: {
    messagesIncluded: number;
    truncated: boolean;
    prefixChars: number;
  };
  goalVisionEnriched: boolean;
  outerReplyLlm: boolean;
  /** 参与决策判定不回复（消息仍已落库） */
  skipped?: boolean;
  skipReason?: string;
  /** 本轮是否执行了内脑子进程 */
  runInner: boolean;
  /** 外脑参与决策原因码（如 group_llm_silent、dm） */
  shouldReplyReason?: string;
}

/**
 * 启动内脑子进程并等待其结束，返回退出码和捕获的 stdout/stderr。
 * 使用 spawnInnerBrainWorker（与 set_goal 工具路径一致），
 * 采用 env-var 参数传递，不再依赖旧的 argv 接口。
 */
export type SpawnInnerBurstFn = (
  workspaceId: string,
  workDir: string,
  maxTicks: number,
) => Promise<{ code: number; stdout: string; stderr: string }>;

function defaultSpawnInnerBurst(
  workspaceId: string,
  workDir: string,
  maxTicks: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const instanceId = `roundtrip-${Date.now()}`;
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const { child } = spawnInnerBrainWorker({
      instanceId,
      workspaceId,
      workDir,
      maxTicks,
    });
    // 除了 spawner 的转发监听器外，额外捕获输出（用于构建 StructuredReply 上下文）
    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function runOuterRoundtrip(
  deps: {
    dataRoot: string;
    registry: IdentityRegistry;
    getEngine: (workspaceId: string) => InnerBrainEngine;
    loadThreads: () => LooseThreadStore;
    saveThreads: (d: LooseThreadStore) => void;
    workspaceStore: FilesystemWorkspaceStore;
    repoStore: FilesystemRepositoryStore;
    /**
     * Chat IR 资产仓库——展开 reply.v1.attach_asset_ids 用。
     * 未提供时跳过展开（`attach_asset_ids` 字段保留但不变成 parts）。
     */
    assetStore?: ChatAssetStore;
    /** 测试注入：替代真实 spawnInnerBrainWorker 子进程 */
    spawnInnerBurst?: SpawnInnerBurstFn;
  },
  p: OuterRoundtripParams,
): Promise<OuterRoundtripResult> {
  const maxTicks = Math.min(10_000, Math.max(1, p.maxTicks ?? 200));
  const afterBurstPolicy = resolveAfterBurstPolicy(p.afterBurst);
  const tenantId = p.tenantId?.trim() || 'default';
  const realm = p.realm?.trim() || `workspace:${p.workspaceId}`;

  deps.workspaceStore.ensureWorkspace(p.workspaceId);
  const workDirForGoal = deps.workspaceStore.resolveWorkDir(p.workspaceId);

  const data = deps.loadThreads();
  ensureThreadShell(data, p.threadId, [p.senderSid]);

  let recordParts: MessagePart[];
  let goalMarkdown: string;
  let priorRaw: unknown[];

  if (p.userMessagePersisted) {
    const rawList = data.messages[p.threadId] ?? [];
    if (rawList.length === 0) {
      throw new Error('user_message_persisted: thread has no messages');
    }
    const lastParsed = MessageRecordSchema.parse(rawList[rawList.length - 1]!);
    if (lastParsed.sender_sid !== p.senderSid) {
      throw new Error(
        `user_message_persisted: last message sender ${lastParsed.sender_sid} !== ${p.senderSid}`,
      );
    }
    recordParts = lastParsed.parts.map((part) => MessagePartSchema.parse(part));
    goalMarkdown = persistMessagePartsToGoalMarkdown(workDirForGoal, recordParts);
    priorRaw = rawList.slice(0, -1);
  } else if (p.messageParts && p.messageParts.length > 0) {
    recordParts = p.messageParts.map((part) => MessagePartSchema.parse(part));
    goalMarkdown = persistMessagePartsToGoalMarkdown(workDirForGoal, recordParts);
    priorRaw = [...(data.messages[p.threadId] ?? [])];
  } else if (p.userText?.trim()) {
    goalMarkdown = p.userText.trim();
    recordParts = [{ type: 'text', text: goalMarkdown }];
    priorRaw = [...(data.messages[p.threadId] ?? [])];
  } else {
    throw new Error('roundtrip requires non-empty userText or messageParts');
  }

  const histOpts = resolveThreadHistoryOpts({
    messageLimit: p.historyLimit,
    maxChars: p.historyMaxChars,
  });
  const threadHist = buildThreadHistoryPrefix(priorRaw, deps.registry, histOpts);

  const eng = deps.getEngine(p.workspaceId);
  const innerStatusSummary = JSON.stringify(eng.readStatus() ?? null);
  const threadKind = p.threadKind ?? 'dm';
  const inboundMeta: OuterInboundMeta = {
    threadKind,
    isMentionAgent: p.isMentionAgent ?? threadKind === 'dm',
    mentionsOthers: p.mentionsOthers ?? false,
    skipParticipationCheck: p.skipParticipationCheck ?? false,
  };
  const proactiveLevel = resolveProactiveLevel();
  const llmEnvEarly = loadInnerLlmEnvFromProcess();
  const participationDecision = await decideOuterShouldReply({
    threadId: p.threadId,
    content: goalMarkdown,
    meta: inboundMeta,
    proactiveLevel,
    threadHistoryPrefix: threadHist.prefix,
    innerStatusSummary,
    llmEnv: llmEnvEarly,
  });

  if (!p.userMessagePersisted) {
    const userMsg = MessageRecordSchema.parse({
      schema: 'message.v1',
      message_id: `msg:${Date.now()}`,
      thread_id: p.threadId,
      sender_sid: p.senderSid,
      sent_at: new Date().toISOString(),
      parts: recordParts,
    });
    const list = data.messages[p.threadId] ?? [];
    list.push(userMsg);
    data.messages[p.threadId] = list;
    deps.saveThreads(data);
  }

  if (!participationDecision.shouldReply) {
    const stSkip = eng.readStatus();
    const innerStatusSkip = stSkip ? { ...stSkip } : null;
    const emptyReply = StructuredReplySchema.parse({
      schema: 'reply.v1',
      thread_id: p.threadId,
      text: '',
      mention_sids: [],
    });
    return {
      reply: emptyReply,
      mock: renderMockChannel(emptyReply),
      innerStatus: innerStatusSkip,
      workerExitCode: -1,
      workerStdout: '',
      lifecycle: {
        afterBurstPolicy,
        goalCompleteSuggested: false,
        promoteShutdownApplied: false,
        promoted: undefined,
      },
      threadHistory: {
        messagesIncluded: threadHist.messagesIncluded,
        truncated: threadHist.truncated,
        prefixChars: threadHist.prefix.length,
      },
      goalVisionEnriched: false,
      outerReplyLlm: false,
      skipped: true,
      skipReason: participationDecision.reason,
      runInner: false,
      shouldReplyReason: participationDecision.reason,
    };
  }

  const runInner = resolveRunInner(p.runInner);
  let goalVisionEnriched = false;
  let spawned: { code: number; stdout: string; stderr: string };

  if (runInner) {
    let goalForInner = threadHist.prefix + goalMarkdown;
    if (resolveEnrichGoalVision(p.enrichGoalVision)) {
      try {
        const enriched = await enrichGoalMarkdownWithVision(workDirForGoal, goalForInner);
        goalForInner = enriched.text;
        goalVisionEnriched = enriched.imagesProcessed > 0;
      } catch (e) {
        console.error('[utlra] enrichGoalMarkdownWithVision failed', e);
      }
    }
    eng.setGoal(goalForInner);
    const spawn = deps.spawnInnerBurst ?? defaultSpawnInnerBurst;
    spawned = await spawn(p.workspaceId, workDirForGoal, maxTicks);
  } else {
    spawned = { code: -1, stdout: '', stderr: '(未运行 inner-worker，run_inner=false)' };
  }

  const workDir = deps.workspaceStore.resolveWorkDir(p.workspaceId);
  const goalCompleteSuggested = runInner ? suggestGoalCompleteForShutdown(workDir) : false;
  let promoteShutdownApplied = false;
  let promoted: { added: number; skipped: string[] } | undefined;

  if (
    runInner &&
    spawned.code === 0 &&
    afterBurstPolicy === 'promote_and_shutdown_if_complete' &&
    goalCompleteSuggested
  ) {
    const fin = runPromoteThenShutdown(deps.repoStore, deps.workspaceStore, eng, p.workspaceId, {
      tenantId,
      realm,
    });
    promoteShutdownApplied = true;
    promoted = fin.promoted;
  }

  const st = eng.readStatus();
  const innerStatus = st ? { ...st } : null;
  const phase = st?.phase ?? 'unknown';
  const last = st?.lastAction ?? '—';
  let text: string;
  if (!runInner) {
    text = `（未执行内脑 burst）外脑仅聊天。阶段: ${phase}；最近动作: ${last}。`;
  } else if (spawned.code === 0) {
    text = `内脑 burst 已结束（exit=0）。阶段: ${phase}；最近动作: ${last}。子进程输出见 workerStdout。`;
  } else {
    text = `内脑子进程异常退出（exit=${spawned.code}）。stderr: ${spawned.stderr.slice(0, 500)}`;
  }

  if (promoteShutdownApplied && promoted) {
    text += ` 【正式流程】已执行 manifest 晋升（${promoted.added} 条）并关闭内脑（SLEEPING）。`;
  } else if (runInner && spawned.code === 0 && goalCompleteSuggested && afterBurstPolicy === 'none') {
    text +=
      ' 【提示】检测到目标已完成（BLOCKED）；可设置环境变量 UTLRA_OUTER_AFTER_BURST=promote_and_shutdown_if_complete 或在请求中传 after_burst，以便外脑自动晋升并关闭内脑。';
  }

  let outerReplyLlm = false;
  let reply: StructuredReply;

  if (resolveOuterLlmReply(p.outerLlmReply)) {
    const llmEnv = loadInnerLlmEnvFromProcess();
    if (llmEnv) {
      try {
        const pack = deps.registry.packForThread(p.threadId, tenantId, 'group', [
          p.senderSid,
          resolvePrimaryAgentSid(),
        ]);
        const payload = await draftOuterStructuredReplyPayload(llmEnv, {
          identityPack: serializeIdentityPack(pack),
          threadHistoryPrefix: threadHist.prefix,
          burstStdout: spawned.stdout,
          burstStderr: spawned.stderr,
          innerPhase: phase,
          innerLast: last,
          templateReply: text,
        });
        reply = mergeStructuredReply(p.threadId, payload);
        outerReplyLlm = true;
      } catch (e) {
        console.error('[utlra] draftOuterStructuredReplyPayload failed', e);
        reply = StructuredReplySchema.parse({
          schema: 'reply.v1',
          thread_id: p.threadId,
          text,
          mention_sids: [],
        });
      }
    } else {
      reply = StructuredReplySchema.parse({
        schema: 'reply.v1',
        thread_id: p.threadId,
        text,
        mention_sids: [],
      });
    }
  } else {
    reply = StructuredReplySchema.parse({
      schema: 'reply.v1',
      thread_id: p.threadId,
      text,
      mention_sids: [],
    });
  }

  const allowed = new Set(deps.registry.list().map((x) => x.sid));
  let v = validateReplyMentions(reply, allowed);
  if (!v.ok) {
    console.error('[utlra] StructuredReply mention 校验失败，回退模板（无 @）', v.error);
    reply = StructuredReplySchema.parse({
      schema: 'reply.v1',
      thread_id: p.threadId,
      text,
      mention_sids: [],
    });
    outerReplyLlm = false;
    v = validateReplyMentions(reply, allowed);
  }
  if (!v.ok) {
    throw new Error(v.error);
  }

  if (!p.skipAppendReply) {
    appendAgentReplyToThread(deps, p.threadId, reply);
  }

  return {
    reply,
    mock: renderMockChannel(reply),
    innerStatus,
    workerExitCode: spawned.code,
    workerStdout: spawned.stdout,
    lifecycle: {
      afterBurstPolicy,
      goalCompleteSuggested,
      promoteShutdownApplied,
      promoted,
    },
    threadHistory: {
      messagesIncluded: threadHist.messagesIncluded,
      truncated: threadHist.truncated,
      prefixChars: threadHist.prefix.length,
    },
    goalVisionEnriched,
    outerReplyLlm,
    skipped: false,
    runInner,
    shouldReplyReason: participationDecision.reason,
  };
}

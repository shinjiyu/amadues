/**
 * 外脑入口类（OuterBrain）。
 *
 * 处理流程（对齐 openKuroneko outer-brain/index）：
 *   1. 规则过滤（DM/群聊 @ / 内容占位符 → 快速决策）
 *   2. 全面知识检索（执行轨 K/S/P + 当前线程历史 + 跨线程历史）
 *   3. 必要时 LLM SPEAK/SILENT 判断（非 think 模式，快速）
 *   4. 外脑对话循环（LLM + 工具：reply_to_user / set_goal / read_inner_status）
 */
import type {
  FilesystemRepositoryStore,
  FilesystemWorkspaceStore,
  InnerBrainEngine,
} from '../workspace-kit/index.js';
import {
  ThreadRecordSchema,
  type ChatAssetStore,
  type ChatIRChannel,
  type ChatIRSeenTracker,
  type IdentityRegistry,
  type LooseThreadStore,
} from '@utlra/chat-ir';
import type { InnerBrainRegistry } from './inner-brain-registry.js';
import type { KpiRegistry } from './kpi-registry.js';
import { loadInnerLlmEnvFromProcess } from '../llm/inner-llm-step.js';
import {
  isHumanSender,
  resolveAwaitingInboundFromIm,
} from './awaiting-inbound-resolver.js';
import { tryStopInnerBrainsFromInbound } from './stop-inner-brain.js';
import {
  decideOuterShouldReply,
  isDmEmptyOrPlaceholderContent,
  participationSpeakLlm,
  resolveParticipationAgentContextFromEnv,
  resolveParticipationUseLlm,
  resolveProactiveLevel,
  type OuterInboundMeta,
} from './inbound-policy.js';
import { retrieveComprehensiveKnowledge } from './knowledge-retrieval.js';
import { runOuterConversationLoop } from './outer-conversation-loop.js';
import { assembleInboundContext, renderInboundHint } from './inbound/inbound-kpi-router.js';
import { resolveAgentSid, resolveWorkspaceId } from './outer-tools.js';
import { MessageRecordSchema } from '@utlra/chat-ir';
import { ThreadOrchestrator, makeFreshCheck } from './thread-orchestrator.js';
import { loadSoul, ensureSoulFile } from './soul.js';
import { loadOuterGoal, ensureOuterGoalFile } from './outer-goal.js';
import { OuterMemoryStore } from './outer-memory.js';
import type { SkillMemoryStore } from '../mem9/skill-memory-store.js';
import type { SkillDrive9Store } from '../drive9/skill-drive9-store.js';
import type { KnowledgeDrive9Store } from '../drive9/knowledge-drive9-store.js';
import type { MemoryBlockStore } from './memory-block-store.js';
import type { IActionLogStore, ActionLogEntry } from '../heartbeat/types.js';
import { writeBornEvent, writeActionEvent } from '../heartbeat/agent-behavior-log.js';

// ── Agent 侧行为日志类型 ────────────────────────────────────────────────────

/**
 * 行为日志条目（Agent 侧内存跟踪）
 *
 * 与 heartbeat 模块的 ActionLogEntry 对齐，但 OuterBrain 内部维护
 * 一份内存副本用于 getRecentActions() 快速查询，无需每次异步读取 store。
 */
export interface LogEntry {
  /** Unix 毫秒时间戳 */
  timestamp: number;
  /** 操作类型 */
  operation_type: string;
  /** 影响范围描述 */
  impact_scope: string;
}

/** 行为日志最大保留条数（避免无限增长） */
const MAX_ACTION_LOG_ENTRIES = 200;

/** typing 信号重发间隔（ms）。需小于前端自动消退超时，保证长生成期间指示器不闪没。 */
const TYPING_REEMIT_MS = Number(process.env['UTLRA_OUTER_TYPING_REEMIT_MS'] ?? '4000');

/**
 * 在「生成回复」期间持续向 channel 发 `typing` 活动信号，结束（成功/异常）发 `idle`。
 *
 * - channel 未实现 `sendActivity`（如 Discord/Null 暂未接）时直接透传，无副作用。
 * - LLM 生成可能数十秒，单次 typing 会被前端超时消退，故按 {@link TYPING_REEMIT_MS} 周期重发。
 * - typing 是瞬时信号，失败仅记日志，绝不影响主回复流程。
 */
async function withTypingActivity<T>(
  imClient: ChatIRChannel,
  threadId: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (typeof imClient.sendActivity !== 'function') return fn();
  const emit = (kind: 'typing' | 'idle'): void => {
    try { imClient.sendActivity?.(threadId, kind); } catch { /* best-effort */ }
  };
  emit('typing');
  const timer = setInterval(() => emit('typing'), Math.max(1000, TYPING_REEMIT_MS));
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    emit('idle');
  }
}
// ── 入站事件 ─────────────────────────────────────────────────────────────────

export interface ImInboundEvent {
  threadId: string;
  senderSid: string;
  message: {
    message_id: string;
    parts: Array<{ type: string; text?: string; [k: string]: unknown }>;
  };
  /** 线程参与者 SID 列表（由 WS 广播携带，可用于群/私聊判断） */
  participantSids?: string[];
}

// ── 外脑构造依赖 ──────────────────────────────────────────────────────────────

export interface OuterBrainDeps {
  imClient: ChatIRChannel;
  /** 消息观察 tracker（反 loop 计数 + 新鲜度检查）。由入口构造并注入。 */
  seenTracker: ChatIRSeenTracker;
  /**
   * Chat IR 资产仓库——内脑产物吸收 + `attach_asset_ids` 解引用。
   * 详见 `doc/protocols/inner-brain-deliverables.md`。
   */
  assetStore: ChatAssetStore;
  registry: IdentityRegistry;
  getEngine: (workspaceId: string) => InnerBrainEngine;
  workspaceStore: FilesystemWorkspaceStore;
  repoStore: FilesystemRepositoryStore;
  loadThreads: () => LooseThreadStore;
  dataRoot: string;
  repoRoot?: string;
  /** 多内脑任务注册表（可选，传入时外脑工具获得多内脑管理能力） */
  innerBrainRegistry?: InnerBrainRegistry;
  /** KPI 注册表（可选，传入时启用 set_kpi / list_kpis / view_kpi 等工具） */
  kpiRegistry?: KpiRegistry;
  /** 外脑记忆层（支持 mem9 云端存储） */
  memoryStore?: OuterMemoryStore;
  /** 技能语义存储层（mem9 shared:skills 命名空间） */
  skillStore?: SkillMemoryStore;
  /** 技能 drive9 存储层（原文存储，优先于 mem9） */
  skillDrive9Store?: SkillDrive9Store;
  /** 事实 drive9 存储层（/knowledge/shared/） */
  knowledgeDrive9Store?: KnowledgeDrive9Store;
  /** Memory Block（keychain / vault blocks） */
  memoryBlockStore?: MemoryBlockStore;
  /** 行为日志存储（可选，由 heartbeat 模块注入，用于心跳检测） */
  actionLogStore?: IActionLogStore;
}

const MAX_AGENT_CHAIN = Number(process.env['UTLRA_OUTER_MAX_AGENT_CHAIN'] ?? '20');

/**
 * agent 链达到此深度后，开始用 LLM 判断话题是否自然结束。
 * 默认 4（前 4 条 agent 消息不做判断，直接回复；之后每轮都检查）。
 */
const AGENT_CHAIN_TOPIC_CHECK_THRESHOLD = Number(
  process.env['UTLRA_OUTER_AGENT_CHAIN_TOPIC_THRESHOLD'] ?? '4',
);

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/** 从 message.parts 提取纯文本 */
function extractTextFromParts(parts: Array<{ type: string; text?: string }>): string {
  return parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('\n')
    .trim();
}

/**
 * 动态扫描 thread 历史消息，收集所有出现过的 sender_sid。
 * 始终包含当前发送者（消息可能尚未落库）。结果去重，自身 agentSid 排到最前。
 */
function resolveThreadSids(
  threadId: string,
  currentSenderSid: string,
  loadThreads: () => LooseThreadStore,
): string[] {
  const seen = new Set<string>();
  seen.add(currentSenderSid);
  try {
    const data = loadThreads();
    for (const m of data.messages[threadId] ?? []) {
      const parsed = MessageRecordSchema.safeParse(m);
      if (parsed.success) seen.add(parsed.data.sender_sid);
    }
  } catch {
    // 文件不存在时忽略
  }
  return Array.from(seen);
}

/**
 * 解析线程类型与 @ 信息。
 *
 * threadKind 判断规则（优先级从高到低）：
 *   1. thread_id 包含 "group" → group
 *   2. WS 广播携带的 participantSids.length >= 3 → 视为 group，要求显式 @
 *   3. 本地 threads.json 中 participant_sids.length >= 3 → 视为 group
 *   4. 否则 → dm（真正的 1:1），任何消息都响应
 *
 * isMentionAgent：
 *   - dm：始终 true（1:1 对话不需要 @）
 *   - group：必须消息中有 @agentSid / @agentName / @助手
 */
function findThreadRecord(
  threadId: string,
  loadThreads: () => LooseThreadStore,
): { kind: 'dm' | 'group'; participant_sids: string[] } | undefined {
  try {
    const data = loadThreads();
    for (const raw of data.threads) {
      const parsed = ThreadRecordSchema.safeParse(raw);
      if (parsed.success && parsed.data.thread_id === threadId) {
        return {
          kind: parsed.data.kind,
          participant_sids: parsed.data.participant_sids,
        };
      }
    }
  } catch {
    // threads.json 不存在时保持原判断
  }
  return undefined;
}

function resolveThreadKind(
  threadId: string,
  loadThreads: () => LooseThreadStore,
  participantSids?: string[],
): 'dm' | 'group' {
  if (threadId.includes('group')) return 'group';

  const record = findThreadRecord(threadId, loadThreads);
  if (record?.kind === 'group') return 'group';
  if (record?.kind === 'dm') return 'dm';

  // WebChat 全局房：IR id 为 webchat:global，不含 "group" 字样
  if (threadId.endsWith(':global')) return 'group';

  if (participantSids && participantSids.length >= 3) return 'group';
  if (record?.participant_sids && record.participant_sids.length >= 3) return 'group';

  return 'dm';
}

function resolveThreadMeta(
  threadId: string,
  agentSid: string,
  content: string,
  parts: Array<{ type: string; text?: string; [k: string]: unknown }>,
  loadThreads: () => LooseThreadStore,
  participantSids?: string[],
): OuterInboundMeta {
  const agentName = process.env['UTLRA_AGENT_NAME']?.trim() || 'Kuroneko';
  const threadKind = resolveThreadKind(threadId, loadThreads, participantSids);

  // 优先看 IR 结构化 mention parts —— webchat-bridge 的 inbound.ts 已把 webchat
  // user_id 翻译成 agentSid，所以 target_sid === agentSid 是权威匹配。
  // 这一步必须在文本匹配之前，因为 extractTextFromParts 会把 mention parts 全丢掉，
  // content 里通常不含 `@xxx` 字面量。
  let isMentionAgent = threadKind === 'dm';
  let hasStructuredMentionToOther = false;
  for (const p of parts) {
    if (p.type !== 'mention') continue;
    const targetSid = String((p as { target_sid?: unknown }).target_sid ?? '');
    if (targetSid === agentSid) {
      isMentionAgent = true;
    } else if (targetSid) {
      hasStructuredMentionToOther = true;
    }
  }

  // 兜底：content 文本里的 @ —— 大小写不敏感，覆盖 webchat user_id / agentName / agentSid / @助手
  if (!isMentionAgent) {
    const lcContent = content.toLowerCase();
    const lcAgentName = agentName.toLowerCase();
    const lcAgentSid = agentSid.toLowerCase();
    const lcAgentUserId = (process.env['WEBCHAT_AGENT_USER_ID']?.split(',')[0] ?? '')
      .trim()
      .toLowerCase();
    if (
      lcContent.includes(`@${lcAgentSid}`) ||
      lcContent.includes(`@${lcAgentName}`) ||
      (lcAgentUserId && lcContent.includes(`@${lcAgentUserId}`)) ||
      content.includes('@助手')
    ) {
      isMentionAgent = true;
    }
  }

  const mentionsOthers = isMentionAgent
    ? false
    : hasStructuredMentionToOther || /@[\w\u4e00-\u9fa5]+/.test(content);

  const ownerSid = process.env['UTLRA_OWNER_SID']?.trim();
  const skipParticipationCheck = !!ownerSid && false; // 保留扩展点
  return { threadKind, isMentionAgent, mentionsOthers, skipParticipationCheck };
}

// ── OuterBrain 类 ─────────────────────────────────────────────────────────────

export class OuterBrain {
  private deps: OuterBrainDeps;
  private orchestrator: ThreadOrchestrator;
  /** Agent 侧行为日志（内存副本，用于 getRecentActions 快速查询） */
  private _actionLog: LogEntry[] = [];

  constructor(deps: OuterBrainDeps) {
    this.deps = deps;
    this.orchestrator = new ThreadOrchestrator();
    const agentName = process.env['UTLRA_AGENT_NAME']?.trim() || 'Kuroneko';
    ensureSoulFile(deps.dataRoot, agentName);
    ensureOuterGoalFile(deps.dataRoot, agentName);

    // ── IP-08: 写入 born 事件（agent 启动时一次性） ──────────────────────
    const agentSid = resolveAgentSid();
    const workspaceId = resolveWorkspaceId();
    const bornScope = `agent:${agentSid} workspace:${workspaceId}`;

    // 写入内存日志
    this._appendLocalLog({ timestamp: Date.now(), operation_type: 'born', impact_scope: bornScope });

    // 写入外部 store（异步，不阻塞构造）
    if (deps.actionLogStore) {
      writeBornEvent(deps.actionLogStore, agentSid, bornScope).catch((err) => {
        console.error('[utlra][outer-brain] failed to write born event to actionLogStore', err);
      });
    }
  }

  /**
   * 获取最近的行为日志条目
   *
   * @param limit  返回的最大条目数（默认 50，从最新往前取）
   * @returns      按 timestamp 降序排列的日志条目数组
   */
  getRecentActions(limit: number = 50): LogEntry[] {
    const start = Math.max(0, this._actionLog.length - limit);
    return this._actionLog.slice(start).reverse();
  }

  /** 供 autonomy resourceProbe 读取 orchestrator 负载 */
  getOrchestratorStats(): { queuedTotal: number; activeThreads: number } {
    return this.orchestrator.getStats();
  }

  /**
   * 追加一条日志到内存数组（自动裁剪超限部分）
   */
  private _appendLocalLog(entry: LogEntry): void {
    this._actionLog.push(entry);
    if (this._actionLog.length > MAX_ACTION_LOG_ENTRIES) {
      this._actionLog = this._actionLog.slice(-MAX_ACTION_LOG_ENTRIES);
    }
  }

  async handleInbound(ev: ImInboundEvent): Promise<void> {
    // 编排器：jitter + debounce + 进程内互斥
    await this.orchestrator.schedule(ev.threadId, () => this._processInbound(ev));
  }

  private async _processInbound(ev: ImInboundEvent): Promise<void> {
    const { threadId, senderSid, message, participantSids } = ev;
    const {
      imClient,
      seenTracker,
      registry,
      getEngine,
      workspaceStore,
      repoStore,
      loadThreads,
      dataRoot,
      innerBrainRegistry,
    } = this.deps;

    const agentSid = resolveAgentSid();
    const workspaceId = resolveWorkspaceId();

    // ── Step 0: 提取文本内容 ─────────────────────────────────────────────────
    const content = extractTextFromParts(
      message.parts as Array<{ type: string; text?: string }>,
    );

    console.log(`[utlra][outer-brain] ← ${senderSid}@${threadId}: ${content.slice(0, 120)}`);

    // ── Step 0.5: agent-to-agent 链深度保护（纯响应式，基于 tracker 全量消息计数）─
    // ChatIRSeenTracker 由入口构造，channel 实现负责在入站/出站时调 track()。
    // countConsecutiveAgentMessages 统计从最后一条人类消息起、末尾连续 agent 消息数。
    // 人类发言时自动归零，无需手动重置。
    const chainLen = seenTracker.countConsecutiveAgentMessages(threadId);
    if (chainLen >= MAX_AGENT_CHAIN) {
      console.warn(
        `[utlra][outer-brain] skip: agent chain depth ${chainLen}/${MAX_AGENT_CHAIN} in ${threadId}`,
      );
      return;
    }

    // ── Step 1: 快速规则过滤（DM 空内容 / 占位符）──────────────────────────
    const meta = resolveThreadMeta(
      threadId,
      agentSid,
      content,
      message.parts as Array<{ type: string; text?: string; [k: string]: unknown }>,
      loadThreads,
      participantSids,
    );
    if (meta.threadKind === 'dm' && isDmEmptyOrPlaceholderContent(content)) {
      console.log(`[utlra][outer-brain] skip: dm_empty_or_placeholder`);
      return;
    }

    // ── Step 0.55: 用户要求停任务 → 真 stop（先于 ask_user resolve，避免误唤醒）──
    if (innerBrainRegistry && isHumanSender(senderSid) && content.trim()) {
      const inboundStop = tryStopInnerBrainsFromInbound(innerBrainRegistry, threadId, content);
      if (inboundStop.stopped.length > 0) {
        console.log(
          `[utlra][stop-inner-brain] inbound auto-stop thread=${threadId} ` +
            `instances=${inboundStop.stopped.join(',')} detail=${inboundStop.summaries.join(';')}`,
        );
      }
    }

    // ── Step 0.6: AWAITING 人消息 → resolve ask_user（changeWatcher 后续 spawn）──
    if (innerBrainRegistry && isHumanSender(senderSid)) {
      const awaitingResolve = await resolveAwaitingInboundFromIm(innerBrainRegistry, ev);
      if (awaitingResolve.resolved) {
        console.log(
          `[utlra][awaiting-resolver] resolved instance=${awaitingResolve.instanceId} ` +
            `pending=${awaitingResolve.pendingId} thread=${threadId}`,
        );
      }
    }

    // ── Step 0.65: 用户取消/完成 → 信念对账（降权 tasks + belief）──
    const memStore = this.deps.memoryStore;
    if (memStore && isHumanSender(senderSid) && content.trim()) {
      const belief = memStore.reconcileFromUserMessage(content, senderSid);
      if (belief.applied) {
        console.log(
          `[utlra][belief-reconcile] ${belief.intent} topic=${belief.topic?.slice(0, 60)} thread=${threadId}`,
        );
      }
    }

    // ── IP-03: 写入 respond 事件（入站消息触发） ──────────────────────────
    const respondScope = `thread:${threadId} from:${senderSid}`;
    this._appendLocalLog({ timestamp: Date.now(), operation_type: 'respond', impact_scope: respondScope });
    if (this.deps.actionLogStore) {
      writeActionEvent(this.deps.actionLogStore, agentSid, 'respond', respondScope).catch((err) => {
        console.error('[utlra][outer-brain] failed to write respond event', err);
      });
    }
    // ── Step 2: 全面知识检索 ─────────────────────────────────────────────────
    const { context: knowledgeContext, sources } = retrieveComprehensiveKnowledge({
      query: content,
      threadId,
      workspaceId,
      repoStore,
      loadThreads,
      registry,
    });
    console.log(
      `[utlra][outer-brain] knowledge: repo=${sources.repo} thread=${sources.currentThread} cross=${sources.crossThread}`,
    );

    // ── Step 3: SPEAK/SILENT 决策（先规则，需要时 LLM）──────────────────────
    const llmEnv = loadInnerLlmEnvFromProcess();
    const proactiveLevel = resolveProactiveLevel();

    // 内脑状态摘要（供 SPEAK/SILENT LLM 参考）
    let innerStatusSummary = '';
    try {
      const st = getEngine(workspaceId).readStatus();
      if (st) {
        innerStatusSummary = [
          `阶段：${st.phase ?? '未知'}`,
          `目标摘要：${st.goalSummary?.slice(0, 120) ?? '无'}`,
          `最近动作：${st.lastAction ?? '—'}`,
        ].join(' | ');
      }
    } catch {
      // 状态文件不存在属正常情况
    }

    const senderIsAgent =
      /^(idp:)?agent:/i.test(senderSid) || registry.get(senderSid)?.kind === 'agent';

    const agentContext = resolveParticipationAgentContextFromEnv(
      process.env,
      this.deps.kpiRegistry
        ? this.deps.kpiRegistry.list({ status: 'active' }).map((k) => k.description)
        : undefined,
    );

    const { shouldReply, reason } = await decideOuterShouldReply({
      threadId,
      content,
      meta,
      proactiveLevel,
      threadHistoryPrefix: knowledgeContext.slice(0, 8000),
      innerStatusSummary,
      llmEnv,
      agentContext,
    });

    console.log(`[utlra][outer-brain] SPEAK decision: ${shouldReply} (${reason})`);
    if (!shouldReply) return;

    workspaceStore.ensureWorkspace(workspaceId);
    const triggerMessageId = ev.message.message_id;
    const freshCheck = makeFreshCheck(seenTracker, threadId, triggerMessageId);
    const toolCtxBase = {
      threadId,
      agentSid,
      workspaceId,
      repoRoot: this.deps.repoRoot,
      imClient,
      assetStore: this.deps.assetStore,
      getEngine,
      workspaceStore,
      repoStore,
      dataRoot,
      freshCheck,
      actionLogStore: this.deps.actionLogStore,
      innerBrainRegistry,
      kpiRegistry: this.deps.kpiRegistry,
      loadThreads,
      memoryStore: this.deps.memoryStore,
      skillStore: this.deps.skillStore,
      skillDrive9Store: this.deps.skillDrive9Store,
      knowledgeDrive9Store: this.deps.knowledgeDrive9Store,
      memoryBlockStore: this.deps.memoryBlockStore,
      inboundHumanSid: isHumanSender(senderSid) ? senderSid : undefined,
    };

    // ── Step 3.4: IM 入站上下文（只读；方案一：前置层不派发，派发交对话环 LLM 工具）──
    // ADL IM-INBOUND-INTENT-ROUTING.md §4：装配本人 active KPI + 在跑 burst → inboundHint 注入对话环。
    // 不再短路 / 不再 dispatchAdHocBurst·kpiRegistry.create·advanceKpi（副作用全部移交 set_goal/set_kpi/advance_kpi/send_directive 工具）。
    let inboundHint = '';
    if (isHumanSender(senderSid) && this.deps.kpiRegistry) {
      const inboundCtx = assembleInboundContext({
        kpiRegistry: this.deps.kpiRegistry,
        innerBrainRegistry: toolCtxBase.innerBrainRegistry,
        defaultThreadId: threadId,
        originUser: senderSid,
      });
      inboundHint = renderInboundHint(inboundCtx);
    }

    // ── Step 3.5: agent 链话题自然结束检查 ──────────────────────────────────
    // 当消息来自另一个 agent 且链已有一定深度时，用 LLM 判断话题是否已充分讨论。
    // 复用现有的 participationSpeakLlm，在 innerStatusSummary 中注入链上下文作为提示。
    if (senderIsAgent && chainLen >= AGENT_CHAIN_TOPIC_CHECK_THRESHOLD && llmEnv && resolveParticipationUseLlm()) {
      const chainContext =
        `【当前为 agent 对话链，已有 ${chainLen} 条连续 agent 消息】` +
        `判断这条消息是否明确在对你说（${agentContext.agentName}）。` +
        `只有在对你说、且话题仍有实质内容可补充时才 SPEAK。` +
        `若在对其他 agent 说话、话题已充分讨论、或只是重复/寒暄，请输出 SILENT。`;
      try {
        const stillSpeak = await participationSpeakLlm(llmEnv, {
          content,
          threadHistoryPrefix: knowledgeContext.slice(0, 8000),
          innerStatusSummary: chainContext,
          proactiveLevel,
          agentContext,
        });
        if (!stillSpeak) {
          console.log(
            `[utlra][outer-brain] skip: agent chain topic concluded (chain=${chainLen})`,
          );
          return;
        }
      } catch (e) {
        console.error('[utlra][outer-brain] agent chain topic check failed', e);
        // 出错时不阻止发送
      }
    }

    // ── Step 4: LLM 无 key 时降级回复 ───────────────────────────────────────
    if (!llmEnv) {
      console.warn('[utlra][outer-brain] no LLM API key configured, sending fallback reply');
      await imClient.postMessage(threadId, {
        sender_sid: agentSid,
        text:
          '（外脑未配置 LLM，无法生成回复。请设置 ZHIPU_API_KEY、KIMI_API_KEY 或 LOCALMODULE_API_KEY；' +
          '仅 PocketCity 时建议 UTLRA_INNER_LLM_PROVIDER=localmodule 并填写 LOCALMODULE_*）',
      });
      return;
    }

    // ── Step 5: 外脑对话循环 ─────────────────────────────────────────────────
    // 动态收集本 thread 出现过的所有 sender_sid，用于 LLM 系统提示中的 sid↔昵称映射
    const threadSids = resolveThreadSids(threadId, senderSid, loadThreads);

    // 每次处理消息时热加载 soul 和 long-term goal（文件改动立即生效）
    const soul = loadSoul(dataRoot);
    const longTermGoal = loadOuterGoal(dataRoot);

    // 记忆注入：将 daily-log 和 tasks 状态附加到知识上下文前面
    const memory   = memStore ? await memStore.readMemoryContext() : { dailyLog: '', tasks: '', hasAny: false };
    const memBlock = memStore ? memStore.formatMemoryForLlm(memory) : '';
    const baseContext = memBlock
      ? memBlock + (knowledgeContext ? '\n\n---\n\n' + knowledgeContext : '')
      : knowledgeContext;
    // 方案一：入站只读上下文（active KPI / 在跑 burst）注入对话环，供 LLM 自行决定是否用工具派发
    const fullContext = inboundHint
      ? inboundHint + (baseContext ? '\n\n---\n\n' + baseContext : '')
      : baseContext;

    const result = await withTypingActivity(imClient, threadId, () => runOuterConversationLoop({
      env: llmEnv,
      ctx: toolCtxBase,
      registry,
      threadSids,
      userMessage: content,
      knowledgeContext: fullContext,
      soul,
      longTermGoal,
    }));

    const toolsChain = result.toolsUsed.length ? result.toolsUsed.join('→') : '(none)';
    const lastPreview =
      result.lastContent?.trim()
        ? result.lastContent.trim().replace(/\s+/g, ' ').slice(0, 120) +
          (result.lastContent.trim().length > 120 ? '…' : '')
        : '(empty)';
    console.log(
      `[utlra][outer-brain] loop done: replied=${result.replied} rounds=${result.roundsUsed} tools=${toolsChain}${!result.replied ? ` lastContent=${lastPreview}` : ''}`,
    );

    // ── IP-04: 若 result.replied，写入 communicate 事件 ────────────────────
    if (result.replied) {
      const communicateScope = `thread:${threadId} to:${senderSid}`;
      this._appendLocalLog({ timestamp: Date.now(), operation_type: 'communicate', impact_scope: communicateScope });
      if (this.deps.actionLogStore) {
        writeActionEvent(this.deps.actionLogStore, agentSid, 'communicate', communicateScope).catch((err) => {
        console.error('[utlra][outer-brain] failed to write communicate event', err);
      });
      }
    }

    // set_goal / send_directive 等行为日志由 outer-conversation-loop 对每个 tool 写入（outer-tool-audit）
    // 对话结束后追加 Daily Log（仅在实际回复了用户时记录）
    if (result.replied && memStore) {
      memStore.appendChatLog({
        threadId,
        userSid: senderSid,
        summary: content.slice(0, 100),
      });
    }
  }
}

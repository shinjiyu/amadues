/**
 * 外脑记忆层（OuterMemoryStore）
 *
 * 双后端：
 *   - drive9  — 任务状态（精确原文，重启后可还原）
 *   - mem9    — 对话日志 + 内脑发现（语义检索，LLM 整理）+ Belief Card
 *
 * 记忆命名空间（mem9 agentId）：
 *   - `${agentSid}:chat`  — 对话日志 + 内脑 ingest + belief_current
 *
 * 设计要点：
 *   - appendChatLog / writeTasks 均 fire-and-forget，不阻塞主流程
 *   - readTasks 同步返回内存缓存（cache-first），保证工具调用不引入等待
 *   - readChatLog / readMemoryContext 为 async（需要 mem9 search）
 *   - Belief Card：同 topic supersede（store/update），见 MEMORY-BELIEF-CARD.md
 *   - 未配置 MEM9_API_KEY 时，对话读操作返回空；未配置 DRIVE9_API_KEY 时，tasks 仅驻留内存
 */

import { Mem9Client } from '../mem9/mem9-client.js';
import { getDrive9Client } from '../drive9/drive9-client.js';
import { formatAgentTimestampShort } from '../agent-time.js';
import {
  deriveBeliefTopic,
  extractRepairTopic,
  formatCurrentBeliefCards,
  parseUserBeliefRepairIntent,
  partitionMemoriesForPrompt,
  readWorkspaceBeliefEvidence,
  upsertBeliefCard,
  type BeliefPolarity,
  type UpsertBeliefCardResult,
} from './memory-belief-card.js';
import {
  BeliefRevisionStore,
  filterMemoriesByValidity,
  formatArchivedBeliefHints,
  reconcileBeliefFromUserMessage,
  type BeliefReconcileResult,
  type BeliefRevision,
} from './memory-belief-reconcile.js';

export type { Mem9Client };

// ── 类型 ─────────────────────────────────────────────────────────────────────

export interface DailyLogEntry {
  threadId: string;
  userSid: string;
  /** 对话摘要（建议 ≤ 100 字符） */
  summary: string;
}

export interface MemoryContext {
  dailyLog: string;
  tasks: string;
  /** 现行 Belief Card 专段（可空） */
  beliefCards: string;
  hasAny: boolean;
}

export interface IngestInnerOutputOpts {
  kpiId?: string;
  workflowId?: string;
  /** 内脑终态是否成功（无 EW 时用） */
  burstOk?: boolean;
}

export interface ReconcileWorkspaceBeliefOpts {
  workspaceId?: string;
  kpiId?: string;
  workflowId?: string;
  burstOk?: boolean;
  /** 显式 polarity 覆盖（如 EW onSettled 已知 run.ok） */
  polarity?: BeliefPolarity;
  source?: string;
}

// ── OuterMemoryStore ─────────────────────────────────────────────────────────

export class OuterMemoryStore {
  private tasksCache = '';
  readonly chatAgentId: string;
  /** drive9 上任务状态文件路径，如 tasks/kuro.md */
  private readonly tasksD9Path: string;
  private readonly beliefStore: BeliefRevisionStore | null;
  private beliefRevisions: BeliefRevision[] = [];

  constructor(
    readonly mem9: Mem9Client | null,
    readonly agentSid: string,
    dataRoot?: string,
  ) {
    this.chatAgentId = `${agentSid}:chat`;
    this.tasksD9Path = `tasks/${agentSid}.md`;
    this.beliefStore = dataRoot ? new BeliefRevisionStore(dataRoot, agentSid) : null;
    if (this.beliefStore) {
      this.beliefRevisions = this.beliefStore.read().revisions;
    }
  }

  /**
   * 异步初始化：优先从 drive9 加载任务状态（精确原文），drive9 不可用时跳过。
   * 建议在 OuterBrain 启动时调用一次。
   */
  async init(): Promise<void> {
    const d9 = getDrive9Client();
    if (d9) {
      try {
        const raw = await d9.read(this.tasksD9Path);
        if (raw.trim()) {
          this.tasksCache = raw.trim();
          console.log('[outer-memory] tasks 已从 drive9 加载');
          return;
        }
      } catch {
        // 文件不存在（404）时正常，无需警告
      }
    }
  }

  // ── 对话日志（Chat Log） ────────────────────────────────────────────────────

  /** 追加对话日志（fire-and-forget）。 */
  appendChatLog(entry: DailyLogEntry): void {
    if (!this.mem9) return;
    const ts      = formatAgentTimestampShort();
    const content = `[${ts}] @${entry.userSid} (${entry.threadId}): ${entry.summary.slice(0, 120)}`;
    void this.mem9
      .store({ content, agentId: this.chatAgentId, metadata: { ts: new Date().toISOString() } })
      .catch(() => {});
  }

  /**
   * 读取对话日志（支持语义过滤）。
   * query 为空时列出最近记录，有值时做语义搜索。
   * 返回值仅为情节层（不含 belief_current）。
   */
  async readChatLog(limit = 30, query?: string): Promise<string> {
    if (!this.mem9) return '（未配置 MEM9_API_KEY）';
    try {
      const mems = await this.mem9.search({ agentId: this.chatAgentId, query, limit });
      if (mems.length === 0) return '（暂无对话日志）';
      const { episodic } = partitionMemoriesForPrompt(mems);
      if (episodic.length === 0) {
        const active = filterMemoriesByValidity(mems);
        if (active.length === 0) return '（暂无有效对话日志；作废记忆已降权过滤）';
        return '（暂无情节日志；现行结论见「现行信念」）';
      }
      const sorted = [...episodic].sort((a, b) => {
        const ta = a.created_at ?? (a.metadata?.['ts'] as string | undefined) ?? '';
        const tb = b.created_at ?? (b.metadata?.['ts'] as string | undefined) ?? '';
        return ta < tb ? -1 : ta > tb ? 1 : 0;
      });
      return sorted.map((m) => `- ${m.content}`).join('\n');
    } catch (e) {
      return `（mem9 搜索失败：${(e as Error).message}）`;
    }
  }

  async readBeliefCardsSection(limit = 40): Promise<string> {
    if (!this.mem9) return '';
    try {
      const mems = await this.mem9.search({
        agentId: this.chatAgentId,
        query: 'belief_current',
        limit,
      });
      const { beliefCards } = partitionMemoriesForPrompt(mems);
      return formatCurrentBeliefCards(beliefCards);
    } catch (e) {
      console.warn('[outer-memory] readBeliefCardsSection failed:', (e as Error).message);
      return '';
    }
  }

  // ── 任务状态（Tasks） ───────────────────────────────────────────────────────

  /** 读取任务状态（同步，从内存缓存）。 */
  readTasks(): string {
    return this.tasksCache || '（暂无任务状态。可用 update_tasks 工具初始化。）';
  }

  /** 写入任务状态。同步更新内存缓存 + fire-and-forget 写入 drive9（精确原文）。 */
  writeTasks(content: string): void {
    this.tasksCache = content.trim();
    const d9 = getDrive9Client();
    if (d9) {
      void d9.write(this.tasksD9Path, this.tasksCache)
        .catch((e: unknown) =>
          console.warn('[outer-memory] drive9 writeTasks 失败:', (e as Error).message),
        );
    }
  }

  // ── 组合上下文（供 LLM 注入） ────────────────────────────────────────────────

  async readMemoryContext(chatQuery?: string): Promise<MemoryContext> {
    const [dailyLog, beliefCards] = await Promise.all([
      this.readChatLog(50, chatQuery),
      this.readBeliefCardsSection(),
    ]);
    const tasks = this.readTasks();
    const hasAny =
      !!beliefCards ||
      (!!this.mem9 &&
        ((dailyLog !== '（暂无对话日志）' &&
          dailyLog !== '（未配置 MEM9_API_KEY）' &&
          !dailyLog.startsWith('（暂无')) ||
          !!this.tasksCache));
    return { dailyLog, tasks, beliefCards, hasAny };
  }

  formatMemoryForLlm(ctx: MemoryContext): string {
    if (!ctx.hasAny && this.beliefRevisions.length === 0 && !ctx.beliefCards) return '';
    const archived = formatArchivedBeliefHints(this.beliefRevisions);
    const parts = ['## 记忆', ''];
    if (ctx.beliefCards) {
      parts.push(ctx.beliefCards, '');
    }
    if (ctx.hasAny || this.tasksCache) {
      parts.push('### 当前任务状态', ctx.tasks, '');
    }
    if (archived) {
      parts.push(archived, '');
    }
    if (ctx.dailyLog && !ctx.dailyLog.startsWith('（未配置') && ctx.dailyLog !== '（暂无对话日志）') {
      parts.push('### 最近对话日志', ctx.dailyLog);
    }
    return parts.join('\n');
  }

  /**
   * 用户 IM 取消/完成 → 强制对账 tasks + 本地 belief 修订（MVP）。
   * 用户「修好了/可用了」→ mem9 Belief Card polarity=ok。
   */
  reconcileFromUserMessage(text: string, userSid: string): BeliefReconcileResult {
    const repair = parseUserBeliefRepairIntent(text);
    if (repair) {
      const topicRaw = extractRepairTopic(text, repair.matched);
      const kpiMatch = topicRaw.match(/\bkpi-[\w-]+\b/i);
      const topic = kpiMatch
        ? deriveBeliefTopic({ kpiId: kpiMatch[0]! })
        : `user:${topicRaw.slice(0, 100).toLowerCase()}`;
      void this.upsertBeliefCard({
        topic,
        summary: `用户确认已修复：${topicRaw.slice(0, 120)}`,
        polarity: 'ok',
        priorSummary: topicRaw.slice(0, 80),
        source: `user_repair:${userSid}`,
      }).then((r) => {
        if (r.applied) {
          console.log(`[utlra][belief-card] user_repair topic=${r.topic} superseded=${r.supersededIds.length}`);
        }
      });
      return { applied: true, intent: 'completed', topic: topicRaw, reason: 'user_repair' };
    }

    const { result, tasks, revisions } = reconcileBeliefFromUserMessage(
      text,
      userSid,
      this.beliefStore,
      this.tasksCache || this.readTasks(),
    );
    if (result.applied) {
      this.beliefRevisions = revisions;
      this.writeTasks(tasks);
      void this.downrankMem9ByTopic(result.topic!, result.intent!);
    }
    return result;
  }

  /** 同 topic Belief Card upsert（门面） */
  async upsertBeliefCard(input: {
    topic: string;
    summary: string;
    polarity: BeliefPolarity;
    priorSummary?: string;
    source: string;
    evidenceAt?: string;
  }): Promise<UpsertBeliefCardResult> {
    if (!this.mem9) {
      return { applied: false, topic: input.topic, supersededIds: [], reason: 'no_mem9' };
    }
    return upsertBeliefCard(this.mem9, this.chatAgentId, input);
  }

  /**
   * 工作区本地证据 → Belief Card（DONE / EW settle）。
   * 无足够证据（unknown）时不写卡，避免用猜测覆盖。
   */
  async reconcileBeliefFromWorkspace(
    workDir: string,
    opts: ReconcileWorkspaceBeliefOpts = {},
  ): Promise<UpsertBeliefCardResult> {
    const evidence = readWorkspaceBeliefEvidence(workDir, {
      burstOk: opts.burstOk,
      workflowId: opts.workflowId,
    });
    const polarity = opts.polarity ?? evidence.polarity;
    if (polarity === 'unknown') {
      return {
        applied: false,
        topic: '',
        supersededIds: [],
        reason: 'insufficient_evidence',
      };
    }

    const topic = deriveBeliefTopic({
      kpiId: opts.kpiId,
      workflowId: opts.workflowId ?? evidence.workflowId,
      workspaceId: opts.workspaceId,
    });

    const result = await this.upsertBeliefCard({
      topic,
      summary: evidence.summary,
      polarity,
      priorSummary: evidence.priorHint,
      source: opts.source ?? (opts.workflowId || evidence.workflowId ? 'ew_settle' : 'inner_complete'),
    });
    if (result.applied) {
      console.log(
        `[utlra][belief-card] workspace topic=${result.topic} polarity=${polarity} superseded=${result.supersededIds.length}`,
      );
    }
    return result;
  }

  private async downrankMem9ByTopic(topic: string, status: 'cancelled' | 'completed'): Promise<void> {
    if (!this.mem9 || !topic.trim()) return;
    const validity = status === 'cancelled' ? 0.15 : 0.25;
    try {
      const hits = await this.mem9.search({ agentId: this.chatAgentId, query: topic, limit: 12 });
      for (const mem of hits) {
        if (!mem.content.includes(topic.slice(0, 20)) && !topic.includes(mem.content.slice(0, 20))) {
          continue;
        }
        await this.mem9.update(mem.id, {
          metadata: {
            ...(mem.metadata ?? {}),
            validity,
            status,
            revised_at: new Date().toISOString(),
          },
        });
      }
    } catch (e) {
      console.warn('[outer-memory] mem9 validity downrank failed:', (e as Error).message);
    }
  }

  // ── 内脑输出 → mem9 自动提取 ───────────────────────────────────────────────

  /**
   * 内脑完成后调用：先按工作区证据 upsert Belief Card，再 smart ingest 情节（fire-and-forget）。
   */
  ingestInnerOutput(workDir: string, workspaceId: string, opts?: IngestInnerOutputOpts): void {
    if (!this.mem9) return;
    const mem9 = this.mem9;
    const agentId = this.chatAgentId;

    void (async () => {
      try {
        await this.reconcileBeliefFromWorkspace(workDir, {
          workspaceId,
          kpiId: opts?.kpiId,
          workflowId: opts?.workflowId,
          burstOk: opts?.burstOk,
          source: 'inner_complete',
        });
      } catch (e) {
        console.warn('[outer-memory] reconcileBeliefFromWorkspace 失败:', (e as Error).message);
      }

      const messages: Array<{ role: string; content: string }> = [];

      const { buildCompletionMessageFromWorkspace } = await import('./completion-notify.js');
      const { message: completionBody } = buildCompletionMessageFromWorkspace(workDir, {
        audience: 'verbose',
      });
      if (completionBody.trim()) {
        messages.push({ role: 'assistant', content: `[内脑任务完成报告]\n${completionBody}` });
      }

      if (messages.length === 0) return;

      try {
        await mem9.ingest({
          messages,
          session_id: `inner:${workspaceId}:${Date.now()}`,
          agent_id:   agentId,
          mode:       'smart',
        });
        console.log(`[outer-memory] inner output ingested to mem9 (workspaceId=${workspaceId})`);
      } catch (e) {
        console.warn('[outer-memory] ingestInnerOutput 失败:', (e as Error).message);
      }
    })();
  }

  // ── 供 dashboard API 读取 ──────────────────────────────────────────────────

  async readDailyLogRaw(maxLines = 200): Promise<string> {
    return this.readChatLog(maxLines);
  }

  readTasksRaw(): string {
    return this.tasksCache || '（暂无任务状态。）';
  }
}

// ── 工厂函数：从环境变量创建 OuterMemoryStore ────────────────────────────────

export function createMemoryStore(dataRoot: string, agentSid: string): OuterMemoryStore {
  const apiKey = process.env['MEM9_API_KEY']?.trim();
  const apiUrl = process.env['MEM9_API_URL']?.trim();

  if (apiKey) {
    const mem9 = new Mem9Client({ apiKey, apiUrl });
    console.log(`[outer-memory] mem9 已启用 agentSid=${agentSid} url=${apiUrl ?? 'https://api.mem9.ai'}`);
    return new OuterMemoryStore(mem9, agentSid, dataRoot);
  }

  console.log('[outer-memory] MEM9_API_KEY 未设置，记忆层不可用（belief/tasks 本地仍可用）');
  return new OuterMemoryStore(null, agentSid, dataRoot);
}

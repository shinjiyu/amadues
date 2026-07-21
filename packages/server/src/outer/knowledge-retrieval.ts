/**
 * 外脑知识检索：查询执行轨知识库（K/S/P）+ 当前线程历史 + 跨线程历史，
 * 合并为一段可直接注入外脑 LLM 上下文的 Markdown 字符串。
 *
 * 注意：drive9 存储 S/K/P（执行轨知识），不适合外脑对话检索。
 * 内脑战术事实走 workspace memory / drive9；外脑对话记忆走 mem9 :chat。
 * 外脑对话时从 mem9 语义召回即可获取。
 */
import type { FilesystemRepositoryStore } from '../workspace-kit/index.js';
import {
  MessageRecordSchema,
  recallPersonMessages,
  serializeMessageForLlm,
  type IdentityBindingIndex,
  type IdentityRegistry,
  type LooseThreadStore,
} from '@utlra/chat-ir';
import { resolveAgentTimezone } from '../agent-time.js';
import { isHumanSender } from './awaiting-inbound-resolver.js';

const MAX_REPO_SESSIONS = 4;
const MAX_CHARS_PER_ITEM = 600;
const MAX_CROSS_THREAD_MSGS = 6;
const MAX_CURRENT_THREAD_MSGS = 20;
const MAX_PERSON_MSGS = 12;

export interface KnowledgeRetrievalResult {
  context: string;
  sources: { repo: number; currentThread: number; crossThread: number; person: number };
}

/**
 * 从执行轨知识库检索 K/S/P 条目，返回格式化字符串。
 */
function retrieveFromRepo(
  repoStore: FilesystemRepositoryStore,
  query: string,
  _workspaceId: string,
): string {
  if (!query.trim()) return '';
  try {
    const tenant = 'default';
    const hits = repoStore.retrieve(tenant, {
      query,
      limit: MAX_REPO_SESSIONS * 6,
    });
    if (!hits.length) return '';

    const lines: string[] = ['### 执行轨知识（K/S/P）'];
    for (const rec of hits.slice(0, MAX_REPO_SESSIONS * 6)) {
      const kind = rec.kind;
      const prefix =
        kind === 'knowledge'
          ? '📖 知识'
          : kind === 'skill'
            ? '🔧 技能'
            : kind === 'policy'
              ? '🚫 红线'
              : '📌';
      const text = rec.body?.slice(0, MAX_CHARS_PER_ITEM) ?? '';
      if (text) lines.push(`${prefix}：${text}`);
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * 从线程历史中提取最近消息，格式化为对话块。
 */
function retrieveFromThread(
  threadId: string,
  loadThreads: () => LooseThreadStore,
  registry: IdentityRegistry,
  maxMsgs: number,
  label: string,
): string {
  try {
    const data = loadThreads();
    const raw = (data.messages[threadId] ?? []).slice(-maxMsgs);
    if (!raw.length) return '';

    const tz = resolveAgentTimezone();
    const lines: string[] = [`### ${label}`];
    for (const m of raw) {
      const parsed = MessageRecordSchema.safeParse(m);
      if (!parsed.success) continue;
      const sender = registry.get(parsed.data.sender_sid);
      lines.push(
        serializeMessageForLlm(
          parsed.data,
          sender?.display_name ?? parsed.data.sender_sid,
          sender?.kind ?? 'human',
          tz,
        ),
      );
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * 跨线程检索：找其他线程里与查询关键词匹配的近期消息，注入为背景知识。
 */
function retrieveCrossThread(
  currentThreadId: string,
  query: string,
  loadThreads: () => LooseThreadStore,
  registry: IdentityRegistry,
): string {
  if (!query.trim()) return '';
  try {
    const data = loadThreads();
    const keywords = query
      .toLowerCase()
      .split(/[\s，。,、？?！!\n]+/)
      .filter((w) => w.length >= 2)
      .slice(0, 8);
    if (!keywords.length) return '';

    const tz = resolveAgentTimezone();
    const hits: string[] = [];
    for (const [tid, msgs] of Object.entries(data.messages)) {
      if (tid === currentThreadId) continue;
      const recent = (msgs ?? []).slice(-30);
      for (const m of recent) {
        const parsed = MessageRecordSchema.safeParse(m);
        if (!parsed.success) continue;
        const text = parsed.data.parts
          .filter((p) => p.type === 'text')
          .map((p) => (p as { text?: string }).text ?? '')
          .join(' ')
          .toLowerCase();
        const matched = keywords.filter((k) => text.includes(k)).length;
        if (matched >= 2) {
          const sender = registry.get(parsed.data.sender_sid);
          hits.push(
            serializeMessageForLlm(
              parsed.data,
              sender?.display_name ?? parsed.data.sender_sid,
              sender?.kind ?? 'human',
              tz,
            ),
          );
          if (hits.length >= MAX_CROSS_THREAD_MSGS) break;
        }
      }
      if (hits.length >= MAX_CROSS_THREAD_MSGS) break;
    }

    if (!hits.length) return '';
    return ['### 跨线程相关历史', ...hits].join('\n');
  } catch {
    return '';
  }
}

/**
 * P3 按人跨会话记忆（IDENTITY-CROSS-CHANNEL.md §6.5）：
 * 入站 sender（已 canonicalize）在**其它** thread（含其它渠道）的近期发言。
 * 别名集来自 bindingIndex——linkMerge 不回写历史消息，旧消息可能带 provisional sid。
 */
function retrievePersonSection(
  senderSid: string,
  currentThreadId: string,
  loadThreads: () => LooseThreadStore,
  registry: IdentityRegistry,
  bindingIndex: IdentityBindingIndex | null | undefined,
): { text: string; count: number } {
  if (!senderSid.trim() || !isHumanSender(senderSid)) return { text: '', count: 0 };
  try {
    const hits = recallPersonMessages(loadThreads(), senderSid, {
      index: bindingIndex ?? null,
      excludeThreadId: currentThreadId,
      maxMessages: MAX_PERSON_MSGS,
    });
    if (!hits.length) return { text: '', count: 0 };

    const tz = resolveAgentTimezone();
    const sender = registry.get?.(senderSid);
    const who = sender?.display_name ?? senderSid;
    const lines: string[] = [
      `### 关于此人（${who}）的跨渠道/跨会话记忆`,
      `（同一人经身份绑定折叠；来自其它会话，按时间新→旧）`,
    ];
    for (const h of hits) {
      const t = h.thread;
      const where = t
        ? t.kind === 'dm'
          ? `${t.channel} 私聊`
          : `${t.channel} 群聊${t.title ? `「${t.title}」` : ''}`
        : h.threadId;
      lines.push(
        `[来自 ${where}] ${serializeMessageForLlm(h.message, who, sender?.kind ?? 'human', tz)}`,
      );
    }
    return { text: lines.join('\n'), count: hits.length };
  } catch {
    return { text: '', count: 0 };
  }
}

/**
 * 全面检索：合并执行轨知识 + 当前线程近期历史 + 跨线程相关消息 + 按人跨会话记忆。
 * 返回可直接注入外脑 LLM prompt 的上下文字符串，以及各来源命中数量。
 *
 * 外脑对话记忆由 OuterMemoryStore 从 mem9 :chat 召回；
 * 不在此函数中查询（mem9 召回已在外脑主流程 buildContext 中合并）。
 */
export function retrieveComprehensiveKnowledge(opts: {
  query: string;
  threadId: string;
  workspaceId: string;
  repoStore: FilesystemRepositoryStore;
  loadThreads: () => LooseThreadStore;
  registry: IdentityRegistry;
  /** 入站发送者（已 canonicalize）；提供时注入「关于此人」跨会话块（P3） */
  senderSid?: string;
  bindingIndex?: IdentityBindingIndex | null;
}): KnowledgeRetrievalResult {
  const { query, threadId, workspaceId, repoStore, loadThreads, registry } = opts;

  const repoSection    = retrieveFromRepo(repoStore, query, workspaceId);
  const threadSection  = retrieveFromThread(threadId, loadThreads, registry, MAX_CURRENT_THREAD_MSGS, '当前对话历史');
  const crossSection   = retrieveCrossThread(threadId, query, loadThreads, registry);
  const personSection  = opts.senderSid
    ? retrievePersonSection(opts.senderSid, threadId, loadThreads, registry, opts.bindingIndex)
    : { text: '', count: 0 };

  const sections = [repoSection, threadSection, personSection.text, crossSection].filter(Boolean);

  const repoCount   = repoSection ? 1 : 0;
  const threadCount = threadSection
    ? Math.min(MAX_CURRENT_THREAD_MSGS, (loadThreads().messages[threadId] ?? []).length)
    : 0;
  const crossCount = crossSection ? crossSection.split('\n').length - 1 : 0;

  if (!sections.length) {
    return { context: '', sources: { repo: 0, currentThread: 0, crossThread: 0, person: 0 } };
  }

  const context = `## 背景知识与历史上下文\n\n${sections.join('\n\n')}`;
  return {
    context,
    sources: {
      repo: repoCount,
      currentThread: threadCount,
      crossThread: crossCount,
      person: personSection.count,
    },
  };
}

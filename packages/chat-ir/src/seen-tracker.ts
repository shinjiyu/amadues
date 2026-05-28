/**
 * `ChatIRSeenTracker` —— chat IR 聊天记录上的"运行时观察"查询。
 *
 * 这是从 `ChatIRChannel` 接口里抽出来的"对消息序列的反思性查询"层：
 * - `countConsecutiveAgentMessages` 与 `hasAnotherAgentRepliedAfter` 跟具体渠道无关，
 *   只是"在消息序列上的反向扫描"，理应跟聊天记录模块一起实现，而不是绑在 channel 上。
 * - channel 实现（DiscordChannel / NullChatIRChannel / future Lark/Slack 桥）只负责
 *   传输与持久化；channel 接口收窄到 `start` / `destroy` / `postMessage`。
 *
 * ## 语义：纯响应式（runtime observed）
 *
 * Tracker **不读 `threads.json` 历史**，只统计通过 `track()` 进来过的消息。这意味着：
 * - agent **进程重启**后 tracker 从空开始，反 loop 计数清零——避免被旧历史卡死。
 * - channel 实现必须在**入站消息落库后**与**出站消息发送成功后**各调一次 `track()`，
 *   tracker 才能看到全量。
 *
 * 若未来需要"启动期 backfill 最近 N 条"，在本类上加 `replayFromStore(store)` 即可，
 * 不破坏现有接口。
 *
 * ## Agent 判断
 *
 * 通过 SID 前缀正则（`/^(idp:)?agent:/i`）+ 可选的 `IdentityRegistry.get(sid)?.kind === 'agent'`
 * 双重判断，跟 `outer-brain` 现有 `senderIsAgent` 一致。
 */
import type { IdentityRegistry } from './runtime/identity-registry.js';

/** 被 tracker 记录的一条消息（窄化版 MessageRecord，按观察序入栈）。 */
export interface SeenMessage {
  message_id: string;
  sender_sid: string;
  /**
   * 结构化 @ 目标 sid 列表（来自 mention parts）。
   * 用于 freshCheck：仅与「触发消息上 @ 到的其它 agent」构成抢答竞争。
   */
  mention_target_sids?: string[];
  /** 内部 LRU 修剪用；调用方可不传，由 tracker 填 Date.now() */
  seen_at?: number;
}

/** 从 MessagePart 列表提取 mention 的 target_sid（去重保序）。 */
export function mentionTargetSidsFromParts(
  parts: ReadonlyArray<{ type: string; target_sid?: string }>,
): string[] {
  const out: string[] = [];
  for (const p of parts) {
    if (p.type === 'mention' && typeof p.target_sid === 'string' && p.target_sid) {
      out.push(p.target_sid);
    }
  }
  return [...new Set(out)];
}

export interface ChatIRSeenTrackerOptions {
  /**
   * agent 自己的 sender_sid。用于 `hasAnotherAgentRepliedAfter` 时区分
   * "另一个 agent 发的" vs "我自己发的"。
   */
  selfAgentSid: string;
  /**
   * 每个 thread 缓存条数上限，默认 100。
   * 超出时丢最旧的——足以覆盖反 loop 与新鲜度检查的窗口。
   */
  maxPerThread?: number;
  /**
   * agent 判断的 fallback：sid 前缀正则不命中时查 registry 的 `kind === 'agent'`。
   * 可不传——此时只用 sid 前缀判断。
   */
  identityRegistry?: IdentityRegistry;
}

const AGENT_SID_RE = /^(idp:)?agent:/i;

export class ChatIRSeenTracker {
  private readonly byThread = new Map<string, SeenMessage[]>();
  private readonly maxPerThread: number;
  private readonly selfAgentSid: string;
  private readonly registry?: IdentityRegistry;

  constructor(opts: ChatIRSeenTrackerOptions) {
    this.selfAgentSid = opts.selfAgentSid;
    this.maxPerThread = opts.maxPerThread ?? 100;
    if (opts.identityRegistry) this.registry = opts.identityRegistry;
  }

  /**
   * 记录一条已观察到的消息。channel 实现应在：
   * - 入站消息（外部 → IR）落库后
   * - 出站消息（IR → 外部）发送成功后
   * 各调一次。**顺序必须严格按时序**——tracker 不会排序，只按 push 顺序保存。
   */
  track(threadId: string, m: SeenMessage): void {
    let list = this.byThread.get(threadId);
    if (!list) {
      list = [];
      this.byThread.set(threadId, list);
    }
    list.push({
      message_id: m.message_id,
      sender_sid: m.sender_sid,
      ...(m.mention_target_sids?.length ? { mention_target_sids: m.mention_target_sids } : {}),
      seen_at: m.seen_at ?? Date.now(),
    });
    while (list.length > this.maxPerThread) list.shift();
  }

  /**
   * 反 agent-loop：统计线程末尾连续 agent 消息数（从最后一条非 agent 之后算起）。
   * 人类 / service 发言时自动归零。纯响应式，不读磁盘 / 不调远端。
   */
  countConsecutiveAgentMessages(threadId: string): number {
    const list = this.byThread.get(threadId) ?? [];
    let count = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i]!;
      if (this.isAgentSender(m.sender_sid)) count++;
      else break;
    }
    return count;
  }

  /**
   * 新鲜度检查：`triggerMessageId` 之后，是否有「与本 agent 抢答同一触发」的另一 agent 发言。
   *
   * 规则（避免「分别 @ 不同人」被误杀）：
   * - 触发消息 **仅 @ 本 agent** → 不视为竞争，返回 false（大群里他人插话不掐断）。
   * - 触发 **@ 了本 agent + 其它 agent** → 仅那些 **同时在触发里被 @ 的 agent** 的后续发言算抢答。
   * - 触发 **无 mention 元数据** → 回退为仅 `idp:agent:` / `agent:` 前缀的 peer（不含 registry 里的 webchat 马甲）。
   *
   * 若 trigger 尚未被 `track()` 进来过，返回 `false`（无信息，按可发送处理）。
   */
  hasAnotherAgentRepliedAfter(threadId: string, triggerMessageId: string): boolean {
    const list = this.byThread.get(threadId) ?? [];
    let foundTrigger = false;
    let triggerMentions: string[] | undefined;
    for (const m of list) {
      if (m.message_id === triggerMessageId) {
        foundTrigger = true;
        triggerMentions = m.mention_target_sids;
        continue;
      }
      if (!foundTrigger) continue;
      if (m.sender_sid === this.selfAgentSid) continue;
      if (this.isCompetingAgentReply(m.sender_sid, triggerMentions)) return true;
    }
    return false;
  }

  /**
   * 该 sender 是否在 freshCheck 语义下与当前触发构成抢答。
   */
  private isCompetingAgentReply(senderSid: string, triggerMentions: string[] | undefined): boolean {
    const mentions = triggerMentions ?? [];

    if (mentions.length > 0) {
      const agentMentions = mentions.filter((sid) => this.isAgentSender(sid));
      const mentionsSelf = agentMentions.includes(this.selfAgentSid);

      // 仅 @ 本 agent（可含 @ 人类）：他人 agent 发言不算抢答
      if (mentionsSelf && agentMentions.length === 1) {
        return false;
      }

      // 多人 @：只有触发里一并 @ 到的其它 agent 算竞争者
      if (mentionsSelf && agentMentions.length > 1) {
        return agentMentions.includes(senderSid) && senderSid !== this.selfAgentSid;
      }

      // 触发未 @ 本 agent（不应走到外脑回复，保守不掐）
      return false;
    }

    // 无 mention 元数据：仅标准 agent sid 前缀（跨进程 idp:agent:*），不把 webchat 马甲当抢答
    return AGENT_SID_RE.test(senderSid);
  }

  /** 测试用：清空所有缓存。 */
  reset(): void {
    this.byThread.clear();
  }

  private isAgentSender(sid: string): boolean {
    if (AGENT_SID_RE.test(sid)) return true;
    if (this.registry?.get(sid)?.kind === 'agent') return true;
    return false;
  }
}

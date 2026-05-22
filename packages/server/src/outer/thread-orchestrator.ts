/**
 * 外脑线程编排器：防止多 agent 并发响应同一 thread 导致消息激荡。
 *
 * 策略：
 *  1. Jitter（随机延迟）：收到消息后先等一段随机时间再开始处理，
 *     错开多个 agent 同时启动 LLM 的概率。
 *  2. Debounce：jitter 期间若同一 thread 有新消息到来，重置计时器，
 *     只处理最新的一批消息（合并上下文）。
 *  3. 进程内互斥锁：同一 thread 同时只允许一个 LLM 调用。
 *     处理中有新触发时最多排队一条（超出的丢弃，等到排队那条处理完再决定是否继续）。
 *  4. 发送前新鲜度检查（cross-process）：LLM 生成完毕、准备 postMessage 前，
 *     查询 IM server 查看是否有其他 agent 在 jitter/处理期间已先发了回复。
 *     若是，丢弃本次结果（静默），避免重复/激荡。
 */

/** 线程状态 */
interface ThreadState {
  /** 进程内是否正在执行 LLM 处理 */
  processing: boolean;
  /** jitter 计时器句柄 */
  jitterTimer: ReturnType<typeof setTimeout> | null;
  /** jitter 期间排队的最新事件（只保留最新，旧的丢弃） */
  queued: (() => Promise<void>) | null;
}

export interface OrchestratorOptions {
  /** jitter 最小毫秒数，默认 300 */
  jitterMinMs?: number;
  /** jitter 最大毫秒数，默认 2000 */
  jitterMaxMs?: number;
}

export class ThreadOrchestrator {
  private threads = new Map<string, ThreadState>();
  private readonly jitterMinMs: number;
  private readonly jitterMaxMs: number;

  constructor(opts?: OrchestratorOptions) {
    this.jitterMinMs = opts?.jitterMinMs ?? Number(process.env['UTLRA_OUTER_JITTER_MIN_MS'] ?? 300);
    this.jitterMaxMs = opts?.jitterMaxMs ?? Number(process.env['UTLRA_OUTER_JITTER_MAX_MS'] ?? 2000);
  }

  private getState(threadId: string): ThreadState {
    let s = this.threads.get(threadId);
    if (!s) {
      s = { processing: false, jitterTimer: null, queued: null };
      this.threads.set(threadId, s);
    }
    return s;
  }

  /**
   * 调度一个处理函数到指定 thread，带 jitter + debounce + 互斥。
   *
   * `taskFn` 是真正的处理逻辑（包括 LLM 调用和 postMessage），
   * 内部应调用 `freshCheck` 做跨进程新鲜度验证后再 postMessage。
   */
  async schedule(threadId: string, taskFn: () => Promise<void>): Promise<void> {
    const state = this.getState(threadId);

    // ── debounce：取消旧 jitter，重新计时 ────────────────────────────────────
    if (state.jitterTimer !== null) {
      clearTimeout(state.jitterTimer);
      state.jitterTimer = null;
    }

    if (state.processing) {
      // 进程内正在处理中：最多排一条，丢弃旧排队
      state.queued = taskFn;
      return;
    }

    // ── jitter 等待 ─────────────────────────────────────────────────────────
    await new Promise<void>((resolve) => {
      const delay =
        this.jitterMinMs + Math.random() * (this.jitterMaxMs - this.jitterMinMs);
      const timer = setTimeout(() => {
        state.jitterTimer = null;
        resolve();
      }, delay);
      state.jitterTimer = timer;
    });

    // jitter 结束后再次检查（可能在等待期间 processing 已结束并触发了 queued）
    if (state.processing) {
      state.queued = taskFn;
      return;
    }

    await this.runWithLock(threadId, taskFn);
  }

  private async runWithLock(threadId: string, taskFn: () => Promise<void>): Promise<void> {
    const state = this.getState(threadId);
    state.processing = true;
    try {
      await taskFn();
    } catch (e) {
      console.error('[utlra][orchestrator] task error', e);
    } finally {
      state.processing = false;
      // 有排队的任务则以 jitter 方式执行
      const next = state.queued;
      if (next) {
        state.queued = null;
        // 不再加 jitter（已经等过了），直接执行
        void this.runWithLock(threadId, next);
      }
    }
  }
}

/**
 * 新鲜度检查工厂：基于 `ChatIRSeenTracker` 的响应式观察（纯内存，不查询远端）。
 *
 * Tracker 在 channel 实现入站落库后 + 出站发送后被 `track()`，已覆盖全量运行时消息。
 * 发送前调用此闭包，若另一个 agent 在 jitter / 处理期间已抢先发了回复，则跳过本次发送。
 */
export function makeFreshCheck(
  seenTracker: { hasAnotherAgentRepliedAfter: (threadId: string, triggerMessageId: string) => boolean },
  threadId: string,
  triggerMessageId: string,
): () => Promise<boolean> {
  return () => Promise.resolve(seenTracker.hasAnotherAgentRepliedAfter(threadId, triggerMessageId));
}

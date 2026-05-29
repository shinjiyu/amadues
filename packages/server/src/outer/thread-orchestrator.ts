/**
 * 外脑线程编排器：防止多 agent 并发响应同一 thread 导致消息激荡。
 *
 * 策略：
 *  1. Jitter（随机延迟）：收到消息后先等一段随机时间再开始处理，
 *     错开多个 agent 同时启动 LLM 的概率。
 *  2. Debounce：jitter 期间若同一 thread 有新消息到来，重置计时器，
 *     只处理最新的一批消息（合并上下文）。
 *  3. 进程内互斥锁：同一 thread 同时只允许一个 LLM 调用。
 *     处理中有新触发时 FIFO 排队（默认最多 5 条，超出丢最旧），全部跑完再释放锁。
 *  4. 发送前新鲜度检查：仅当「触发消息上被一并 @ 的其它 agent」已抢先回复时才放弃发送；
 *     单独 @ 本 agent 时，大群里其它 agent 插话不触发放弃（见 ChatIRSeenTracker）。
 */

const DEFAULT_MAX_QUEUED_PER_THREAD = 5;

function resolveMaxQueuedPerThread(): number {
  const n = Number(process.env['UTLRA_ORCHESTRATOR_MAX_QUEUED'] ?? DEFAULT_MAX_QUEUED_PER_THREAD);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MAX_QUEUED_PER_THREAD;
}

/** 线程状态 */
interface ThreadState {
  /** 进程内是否正在执行 LLM 处理 */
  processing: boolean;
  /** jitter 计时器句柄 */
  jitterTimer: ReturnType<typeof setTimeout> | null;
  /** 处理中积压的入站任务（FIFO，避免「后一条 @」覆盖前一条） */
  queued: Array<() => Promise<void>>;
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
      s = { processing: false, jitterTimer: null, queued: [] };
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
      const maxQueued = resolveMaxQueuedPerThread();
      if (state.queued.length >= maxQueued) {
        state.queued.shift();
      }
      state.queued.push(taskFn);
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
      const maxQueued = resolveMaxQueuedPerThread();
      if (state.queued.length >= maxQueued) {
        state.queued.shift();
      }
      state.queued.push(taskFn);
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
      const next = state.queued.shift();
      if (next) {
        await this.runWithLock(threadId, next);
      } else {
        state.processing = false;
      }
    }
  }

  /** 供 resourceProbe 观测 orchestrator 队列与活跃 thread */
  getStats(): { queuedTotal: number; activeThreads: number } {
    let queuedTotal = 0;
    let activeThreads = 0;
    for (const state of this.threads.values()) {
      queuedTotal += state.queued.length;
      if (state.processing) activeThreads += 1;
    }
    return { queuedTotal, activeThreads };
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

/**
 * Pending 数据类型 — 统一异步等待 / 定时 / 子任务 / 信号
 *
 * 设计文档：doc/agent-data-state-machine.md §4.3
 *
 * 每个 pending 表达「agent 正在等什么 / 等到何时 / 超时怎么办 / 结果落哪」，
 * 由数据 + ChangeWatcher 共同驱动状态机演进。
 */

/** 当前 Phase 1 支持的 pending 种类。后续可加 subtask / http_poll / signal / any_of / all_of */
export type PendingKind =
  | 'ask_user'   // 等用户回复
  | 'timer'      // 等到达指定时间
  | 'signal';    // 等命名信号（兜底，配合 wake_signal 工具用）

export type PendingStatus =
  | 'pending'
  | 'resolved'
  | 'timed_out'
  | 'cancelled';

export type OnTimeoutAction =
  | 'block'                // 转为 BLOCKED（人工兜底）
  | 'resolve_with_default' // 用 default_result 当作 resolved
  | 'cancel';              // 视为已取消，agent 自己决定下一步

export interface OnTimeoutSpec {
  action: OnTimeoutAction;
  /** action=resolve_with_default 时使用；其它 action 忽略 */
  default_result?: unknown;
  /** action=block 时附带的提示信息 */
  reason?: string;
}

/** 通用 spec 的具体形态因 kind 而异 */
export interface AskUserSpec {
  /** 给用户看的问题（IM channel 收到的文本） */
  prompt: string;
  /** 接收回复的渠道（默认 agent 主线程） */
  channel?: string;
  /** 提示用户回复时的引导（默认："请直接回复"） */
  hint?: string;
}

export interface TimerSpec {
  /** ISO 8601 时间戳，>= now 时视为待触发 */
  execute_at: string;
}

export interface SignalSpec {
  /** 信号名（外部 webhook / 工具用 wake_signal 唤醒时匹配） */
  signal_name: string;
}

/**
 * "设这个 pending 时的内心独白"——LLM 创建 pending 时留下的意图备忘。
 *
 * 设计目的（拟人映射）：
 *   人类设闹钟时,**当下**就在想"我设 10 分钟是因为我估计 Shiro 那时大概跑完编译"——
 *   不是闹钟响了再现思考。intent 记录的就是这个"当下的预期"。
 *   唤醒时 executor 会把 intent 注入 LLM 上下文,实现"前后呼应"而不需要额外 LLM 调用。
 *
 * 全部可选。LLM 不传 intent 也能正常工作,只是失去前后呼应的能力。
 */
export interface PendingIntent {
  /** 我设这个 pending 是基于什么期望 / 假设 */
  expectation: string;
  /** 醒来时应该验证的信号 / 关注点 */
  success_signal?: string;
  /** 如果期望落空 / 验证不通过,预期的回退动作 */
  fallback?: string;
}

export interface PendingItem {
  /** workspace 内唯一 id */
  id: string;
  kind: PendingKind;
  /** 关联回 LLM 的 tool_call_id；ChangeWatcher resolve 时不直接用，executor 拿来注入对话 */
  ctxRef?: string;
  /** kind-specific 参数 */
  spec: AskUserSpec | TimerSpec | SignalSpec;
  /** ISO 8601；省略时永不超时（极少用） */
  deadline?: string;
  /** 超时策略；省略时默认 block */
  on_timeout?: OnTimeoutSpec;
  /**
   * 拟人意图（可选）：LLM 创建 pending 时留下的"内心独白",
   * 唤醒后由 executor 注入下一轮 LLM 上下文。
   */
  intent?: PendingIntent;
  status: PendingStatus;
  /** resolved/timed_out 时由 ChangeWatcher 或 executor 写入 */
  result?: unknown;
  /** ISO 8601 创建时间 */
  createdAt: string;
  /** ISO 8601 status 最后变更时间 */
  updatedAt: string;
  /** resolved/timed_out 是否已被下一次 tick 消费（注入 LLM 对话），消费后 status 不变但 consumed=true */
  consumed?: boolean;
  /** 出处便于调试（可选） */
  source?: string;
}

export const PENDINGS_FILENAME = 'pendings.json';

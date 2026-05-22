/**
 * Chat IR Channel —— agent 与 chat 系统的运行时**传输**抽象层。
 *
 * 与 `schemas/` 的关系：
 * - `schemas/*`：**数据模型**（MessageRecord / ThreadRecord 等 zod schema）
 * - `channel.ts`：**传输接口**——start / destroy / postMessage + 入站 callback
 *
 * 设计意图：把 agent 业务代码（`outer/*`）与具体 IM 实现解耦。
 * agent 只面对 1 个方法 + 1 个 callback + 2 个生命周期 hook，不知道也不在乎背后是
 * Discord / Slack / Lark / 本地 fake。
 *
 * ## 关注点边界（重要）
 *
 * 历史曾有 `countConsecutiveAgentMessages` / `hasAnotherAgentRepliedAfter` 挂在本接口上，
 * 但它们**跟具体渠道无关**——只是对消息序列的反向扫描。
 * 已抽到 `ChatIRSeenTracker`（见 `seen-tracker.ts`），由入口统一构造，
 * 同时注入给 channel（用来 `track`）和 agent 业务（用来 query）。
 *
 * 本接口现在只剩**传输**职责：
 * - `start()` / `destroy()`：连接生命周期
 * - `postMessage()`：出站
 * - `onAgentMessage` callback：入站
 *
 * ## 当前与未来的 ChatIRChannel 实现
 *
 * - **`DiscordChannel`**（`@utlra/discord-bridge`）—— **当前唯一实现**
 * - **未来候选**：`NullChatIRChannel`（`@utlra/server` 内置）/ `LarkChatIRChannel` /
 *   `SlackChatIRChannel` / `InMemoryChatIRChannel`（CLI / 测试）
 */

/**
 * Chat IR 出站消息体（agent → channel）。
 *
 * `text` 与 `parts` 二选一：
 * - `text` 是纯文本快捷路径，channel 实现负责 wrap 成 `{ type: 'text', text }`
 * - `parts` 是完整富结构（mention / quote / attachment 等），形状参见 `MessagePart`
 */
export interface ChatIROutboundBody {
  /** 发送者 SID（通常是 agent 自己的 sid） */
  sender_sid: string;
  /** 纯文本快捷路径 */
  text?: string;
  /** 完整 parts 数组（mention / link / asset_ref 等富结构） */
  parts?: unknown[];
  /** 让 channel 实现解析 `@token` 为 mention parts；默认 true */
  parse_mentions?: boolean;
}

/**
 * Chat IR 入站消息（agent 业务代码看到的形状）。
 *
 * 与 `MessageRecord` schema 的关系：本接口是 `MessageRecord` 的运行时窄化版，
 * 只列 `outer/*` 真正用到的字段。完整 schema 见 `chat-ir.ts`。
 */
export interface ChatIRInboundMessage {
  message_id: string;
  thread_id: string;
  sender_sid: string;
  sent_at: string;
  parts: Array<{ type: string; text?: string; [k: string]: unknown }>;
}

/**
 * Chat IR 入站事件 envelope。
 *
 * 由 channel 实现在收到新消息时构造，递给注册的 `onAgentMessage` callback。
 * Channel 实现负责过滤"自己发的消息"和"不是本 agent 参与的线程"——agent 业务代码假定
 * 收到的事件都是它该处理的。
 */
export interface ChatIRInboundEvent {
  threadId: string;
  senderSid: string;
  message: ChatIRInboundMessage;
  /** 线程参与者 SID 列表，可用于群/私聊判断；可能为空数组 */
  participantSids: string[];
}

/**
 * Chat IR Channel 的运行时接口。
 *
 * agent 业务代码（`outer/*`）的 IM 依赖应通过此接口表达，**不要 import 具体实现类**。
 * 入口（`packages/server/src/index.ts`）是唯一应该知道并 `new` 具体实现的地方。
 */
export interface ChatIRChannel {
  /**
   * 启动 channel：连接外部资源、注册订阅、启动心跳等。幂等。
   * 实现不应在 `start()` 内阻塞等待连接成功——连不上应在后台重试，不阻塞 agent 主进程。
   */
  start(): void;

  /**
   * 销毁 channel：断开连接、清理 timer、释放资源。
   */
  destroy(): void;

  /**
   * 出站：发消息到指定线程。
   *
   * 实现应处理网络错误（不抛异常，记日志即可）。
   * 实现**应在发送成功后**调一次 `seenTracker.track(threadId, { message_id, sender_sid })`，
   * 以便后续 `countConsecutiveAgentMessages` / `hasAnotherAgentRepliedAfter` 能看到这条出站。
   * 同样地，入站消息落库后也应调一次 `seenTracker.track(...)`——见 `seen-tracker.ts`。
   */
  postMessage(threadId: string, body: ChatIROutboundBody): Promise<void>;
}

/**
 * 构造 Chat IR Channel 实例的通用参数。
 *
 * 具体实现可以扩展（例如 `DiscordChannelOptions` 加 `config` 等 transport-specific 字段）。
 */
export interface ChatIRChannelInitOptions {
  /** agent 自身的 sender_sid（用于过滤自己发的消息） */
  agentSid: string;
  /** agent 显示名称（用于 presence / identity 自动 upsert） */
  displayName?: string;
  /**
   * 收到应由 agent 处理的消息时调用（human → agent 私聊 / 群 @agent）。
   * 由具体实现负责过滤，agent 业务代码可以无条件处理。
   */
  onAgentMessage: (ev: ChatIRInboundEvent) => Promise<void>;
}

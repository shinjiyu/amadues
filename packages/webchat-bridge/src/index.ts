/**
 * `@utlra/webchat-bridge` —— ChatIRChannel 的 WebChat 实现。
 *
 * 通过 HTTP + WebSocket 对接独立 `chat-server` 进程：
 * - inbound：WS `message.new` → 翻译为 `MessageRecord` → 落 chat IR store → 触发 `onAgentMessage`
 * - outbound：agent 调 `postMessage(threadId, body)` → chat-server REST → 同时落 store
 *
 * 与 `@utlra/discord-bridge` 形态对齐，详见 [packages/discord-bridge/src/discord-channel.ts](../../../packages/discord-bridge/src/discord-channel.ts)。
 */
export * from './config.js';
export * from './webchat-channel.js';

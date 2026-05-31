/**
 * `@utlra/webchat-protocol` —— chat-server / web-chat / webchat-bridge 三方共享：
 *
 * - REST 请求/响应 zod schema（{@link ./rest-types}）
 * - WebSocket 事件 discriminated union（{@link ./events}）
 * - thread_id 工具（{@link ./ids}）
 *
 * 设计原则：
 * - 仅 zod 与 TypeScript，无 node / 浏览器 API，浏览器/服务端通吃。
 * - 所有时间字段统一 ISO 8601 with offset（与 `@utlra/chat-ir` 对齐）。
 * - 任何变更都同步更新 [doc/protocols/webchat-wire.md](../../../doc/protocols/webchat-wire.md)。
 */

export * from './rest-types.js';
export * from './events.js';
export * from './ids.js';
export * from './mention-tokens.js';

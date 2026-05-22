/**
 * Chat IR schemas —— 纯 zod 数据模型集合。
 *
 * 这个子模块**零 node 依赖**，可被任何 JS 环境引用（浏览器 / Edge / Deno / Cloudflare Workers）：
 *
 * ```ts
 * import { MessageRecordSchema, IdentityRecordSchema, StructuredReplySchema } from '@utlra/chat-ir/schemas';
 * ```
 *
 * 持 state 的运行时实现见 `@utlra/chat-ir/runtime`；纯函数工具与接口仍在顶层 `@utlra/chat-ir`。
 */
export * from './message.js';
export * from './identity.js';
export * from './reply.js';

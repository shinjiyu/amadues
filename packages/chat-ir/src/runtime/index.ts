/**
 * Chat IR runtime —— Node 进程内 fs-bound 实现。
 *
 * 仅在 Node / 类 Node 环境（Bun, Deno with node-fs compat 等）使用：
 *
 * ```ts
 * import { IdentityRegistry, ChatAssetStore } from '@utlra/chat-ir/runtime';
 * ```
 *
 * 数据模型与纯函数工具见 `@utlra/chat-ir/schemas` 与 `@utlra/chat-ir` 顶层。
 */
export * from './identity-registry.js';
export * from './identity-binding-index.js';
export * from './resolve-inbound-sender.js';
export * from './person-message-recall.js';
export * from './fan-in-channel.js';
export * from './asset-store.js';

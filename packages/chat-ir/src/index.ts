/**
 * `@utlra/chat-ir` 顶层公开 API。
 *
 * 包内分层：
 *
 * | 子模块                          | 依赖           | 推荐 import 路径              |
 * |---------------------------------|----------------|-------------------------------|
 * | 纯 zod 数据 schema              | zod            | `@utlra/chat-ir/schemas`      |
 * | fs-bound 运行时（class）        | node:fs, zod   | `@utlra/chat-ir/runtime`      |
 * | 接口 / 序列化 / 工具函数        | 仅 type        | `@utlra/chat-ir`（本文件）    |
 *
 * 本 barrel 把全部公开 API 扁平 re-export 一份，**保证现有 `from '@utlra/chat-ir'`
 * 调用方零破坏**。新代码推荐用 subpath import 以获得更小的依赖图。
 */

export * from './schemas/index.js';
export * from './runtime/index.js';
export * from './channel.js';
export * from './seen-tracker.js';
export * from './agent-sid.js';
export * from './serialize.js';
export * from './thread-store.js';
export * from './mention.js';
export * from './reply-utils.js';

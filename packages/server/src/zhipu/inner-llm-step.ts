/**
 * 兼容层：旧路径保留为 re-export。
 *
 * 新实现已迁到 `src/llm/inner-llm-step.ts`，
 * 以便 outer / inner-step 侧共享同一套 provider-neutral LLM 层。
 */
export * from '../llm/inner-llm-step.js';

/**
 * 默认 IM 线程解析 — push-loop / set_goal / KPI 自动续跑共用。
 *
 * 优先级：显式 origin_thread → 对话 ctx.threadId → env 默认线程。
 */
import type { InnerBrainRegistry } from './inner-brain-registry.js';

export function resolveDefaultImThreadId(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['UTLRA_OUTER_HEARTBEAT_THREAD_ID']?.trim();
  if (explicit) return explicit;
  const channel = env['UTLRA_CHAT_CHANNEL']?.trim().toLowerCase();
  const globalId = env['WEBCHAT_GLOBAL_THREAD_ID']?.trim();
  if (channel === 'webchat' && globalId) {
    return globalId.startsWith('webchat:') ? globalId : `webchat:${globalId}`;
  }
  return '';
}

/** set_goal / self-update 注册 TaskRecord 时使用 */
export function resolveTaskOriginThread(
  explicitThread: string | undefined,
  ctxThreadId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return explicitThread?.trim() || ctxThreadId.trim() || resolveDefaultImThreadId(env);
}

/** KPI 自动反思 / 续跑：继承同 KPI 最近 burst 的 thread，否则 env 默认 */
export function resolveKpiBurstOriginThread(
  burstInstanceIds: string[],
  registry: InnerBrainRegistry,
  env: NodeJS.ProcessEnv = process.env,
): string {
  for (let i = burstInstanceIds.length - 1; i >= 0; i--) {
    const thread = registry.get(burstInstanceIds[i]!)?.originThread?.trim();
    if (thread) return thread;
  }
  return resolveDefaultImThreadId(env);
}

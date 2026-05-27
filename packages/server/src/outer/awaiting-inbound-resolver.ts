/**
 * IM 人消息 → 同 thread 的 ask_user pending resolve（不 spawn，交给 changeWatcher）。
 *
 * @see doc/structurizr/INNER-BRAIN-AWAITING-LIFECYCLE.md §5.2
 * @see doc/todo/inner-brain-awaiting-lifecycle.md
 */
import type { InnerBrainRegistry } from './inner-brain-registry.js';
import type { ImInboundEvent } from './outer-brain.js';

export interface AwaitingInboundResolveResult {
  resolved: boolean;
  instanceId?: string;
  pendingId?: string;
  reason: string;
}

export function inboundMessageText(ev: ImInboundEvent): string {
  return ev.message.parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text!)
    .join('\n')
    .trim();
}

export function isHumanSender(senderSid: string): boolean {
  return !senderSid.startsWith('idp:agent:') && !senderSid.startsWith('agent:');
}

/**
 * 确定性 resolve：单 AWAITING 实例 + 最近 pending ask_user。
 * 实现待 P0（当前恒不 resolve，单测将失败直至落地）。
 */
export function resolveAwaitingInboundFromIm(
  _registry: InnerBrainRegistry,
  _ev: ImInboundEvent,
): AwaitingInboundResolveResult {
  return { resolved: false, reason: 'not_implemented' };
}

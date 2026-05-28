/**
 * WebSocket Upgrade 鉴权。
 *
 * 顺序与 HTTP middleware 一致：
 *   1. `Authorization: Bearer <AGENT_SECRET>` + `X-User-Id` 命中保留 agent → AgentPrincipal
 *      （注意：浏览器 WebSocket API 不能塞 Authorization header；该路径仅 Node 端 agent bridge 用）
 *   2. cookie wc_token / wc_refresh → UserPrincipal
 *   3. 否则 anonymous（hub 会拒绝 hello）
 */
import type { IncomingMessage } from 'node:http';

import type { AuthService } from './service.js';
import type { Principal } from './types.js';

export interface UpgradeContext {
  service: AuthService;
  agentUserIds: ReadonlySet<string>;
  agentSecret: string | null;
}

export async function authenticateUpgrade(
  req: IncomingMessage,
  ctx: UpgradeContext,
): Promise<Principal> {
  const auth = req.headers['authorization'];
  const claimedUserId = headerString(req.headers['x-user-id']);
  if (
    ctx.agentSecret &&
    auth &&
    claimedUserId &&
    auth.toLowerCase().startsWith('bearer ') &&
    auth.slice(7).trim() === ctx.agentSecret &&
    ctx.agentUserIds.has(claimedUserId)
  ) {
    return { kind: 'agent', userId: claimedUserId };
  }

  try {
    const principal = await ctx.service.authenticateUpgrade(req);
    if (principal) return principal;
  } catch (e) {
    console.warn('[chat-server][ws-auth] cookie auth failed:', (e as Error).message);
  }

  return { kind: 'anonymous' };
}

function headerString(v: string | string[] | undefined): string | undefined {
  if (!v) return undefined;
  return Array.isArray(v) ? v[0]?.trim() : v.trim();
}

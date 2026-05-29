/**
 * WebSocket Upgrade 鉴权。
 *
 * 顺序与 HTTP middleware 一致：
 *   1. `Authorization: Bearer <AGENT_SECRET>` + `X-User-Id` → AgentPrincipal（secret 对即可）
 *      （注意：浏览器 WebSocket API 不能塞 Authorization header；该路径仅 Node 端 agent bridge 用）
 *   2. cookie wc_token / wc_refresh → UserPrincipal
 *   3. 否则 anonymous（hub 会拒绝 hello）
 */
import type { IncomingMessage } from 'node:http';

import type { AuthService } from './service.js';
import type { Principal } from './types.js';
import { extractBearerToken, resolveAgentPrincipal } from './agent-bypass.js';

export interface UpgradeContext {
  service: AuthService;
  agentUserIds: ReadonlySet<string>;
  agentSecret: string | null;
}

export async function authenticateUpgrade(
  req: IncomingMessage,
  ctx: UpgradeContext,
): Promise<Principal> {
  const claimedUserId = headerString(req.headers['x-user-id']);
  const agentPrincipal = resolveAgentPrincipal({
    agentSecret: ctx.agentSecret,
    agentUserIds: ctx.agentUserIds,
    claimedUserId,
    providedSecret: extractBearerToken(headerString(req.headers['authorization'])),
  });
  if (agentPrincipal) return agentPrincipal;

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

import type { AgentPrincipal } from './types.js';

/**
 * Agent 旁路鉴权：共享 `WEBCHAT_AGENT_SECRET` 正确即可视为 agent。
 *
 * - 生产/bridge：`Authorization: Bearer <secret>` + `X-User-Id`（或 WS hello 里的 `agent_secret`）
 * - `WEBCHAT_AGENT_USER_ID` **可选**：仅当配置了非空列表时，在 secret 正确的基础上再限制 user_id（收紧模式）
 * - 未配置或留空 → 任意 user_id + 正确 secret 即可，新增 robot 无需改服务端白名单
 */
export interface AgentBypassInput {
  agentSecret: string | null;
  agentUserIds: ReadonlySet<string>;
  claimedUserId: string | undefined;
  /** Bearer token（不含 `Bearer ` 前缀）或 hello 里的 `agent_secret` */
  providedSecret: string | undefined;
}

export function extractBearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const lower = authorization.toLowerCase();
  if (!lower.startsWith('bearer ')) return undefined;
  const token = authorization.slice(7).trim();
  return token.length > 0 ? token : undefined;
}

export function resolveAgentPrincipal(input: AgentBypassInput): AgentPrincipal | null {
  const { agentSecret, agentUserIds, claimedUserId, providedSecret } = input;
  if (!agentSecret || !providedSecret || providedSecret !== agentSecret) return null;

  const userId = claimedUserId?.trim();
  if (!userId) return null;

  if (agentUserIds.size > 0 && !agentUserIds.has(userId)) return null;

  return { kind: 'agent', userId };
}

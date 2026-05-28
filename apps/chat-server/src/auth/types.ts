/**
 * Auth 模型类型。
 *
 * 设计取舍：
 * - Whitelist 决定「谁能进 WebChat」，独立于 loginserver 的账号体系（loginserver 只管密码）。
 * - 当前 MVP 不签 API token，agent 走 `WEBCHAT_AGENT_SECRET` 单独的旁路；
 *   token / admin 角色为后续扩展预留。
 */

export type Role = 'admin' | 'member';
export type WhitelistStatus = 'active' | 'disabled';

export interface WhitelistEntry {
  email: string;
  /** 显示用昵称；loginserver 注册时填的 username（缺省退化为 email 前缀）。 */
  displayName: string;
  /** loginserver 返回的稳定 user_id（Mongo ObjectId 字符串）。首次登录后回填。 */
  userId: string | null;
  role: Role;
  status: WhitelistStatus;
  addedBy: string;
  addedAt: number;
  updatedAt: number;
}

export interface AuthData {
  whitelist: WhitelistEntry[];
}

export interface UserPrincipal {
  kind: 'user';
  /** loginserver user_id（Mongo ObjectId 字符串）。chat-server 内部主键即此。 */
  userId: string;
  email: string;
  displayName: string;
  role: Role;
}

export interface AgentPrincipal {
  kind: 'agent';
  /** 由 `WEBCHAT_AGENT_USER_ID` 配置出来的保留 user_id（如 `kuroneko`）。 */
  userId: string;
}

export interface AnonymousPrincipal {
  kind: 'anonymous';
}

export type Principal = UserPrincipal | AgentPrincipal | AnonymousPrincipal;

export function principalUserId(p: Principal): string | null {
  if (p.kind === 'user') return p.userId;
  if (p.kind === 'agent') return p.userId;
  return null;
}

export function principalIsAdmin(p: Principal): boolean {
  return p.kind === 'user' && p.role === 'admin';
}

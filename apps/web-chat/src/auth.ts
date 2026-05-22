/**
 * 客户端身份存储 —— localStorage。
 *
 * 无认证：客户端自报 user_id / display_name。点"登出"清除。
 */
const STORAGE_KEY = 'webchat.identity.v1';

export interface ClientIdentity {
  user_id: string;
  display_name: string;
}

export function loadIdentity(): ClientIdentity | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ClientIdentity;
    if (typeof parsed?.user_id !== 'string' || typeof parsed?.display_name !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveIdentity(id: ClientIdentity): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(id));
}

export function clearIdentity(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * 用 display_name 生成稳定的 user_id（无认证模式下接近"用户名"）。
 * 仅保留 [a-z0-9_-]，长度 1..32；为空时降级为 `user_<random>`。
 */
export function suggestUserId(displayName: string): string {
  const clean = displayName.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 32);
  if (clean.length > 0) return clean;
  const rand = Math.random().toString(36).slice(2, 8);
  return `user_${rand}`;
}

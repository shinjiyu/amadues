/**
 * 浏览器侧 REST 客户端 —— 走 HttpOnly cookie 鉴权。
 *
 * 不再传 `X-User-Id`（服务器从 cookie 解出 principal）。
 * 任何 401 直接抛错，App 层会跳回登录页。
 */
import type {
  Message,
  Thread,
  UploadResponse,
  UserPresence,
  PostMessageRequest,
} from '@utlra/webchat-protocol';

/**
 * BASE_URL 由 Vite `base` 决定：
 * - dev：`/` → `API_BASE = '/api'`（vite proxy 把 `/api/*` 转 chat-server）
 * - 子路径生产部署：`/webchat/` → `API_BASE = '/webchat/api'`（nginx 转 chat-server）
 */
const BASE_URL = import.meta.env.BASE_URL.replace(/\/+$/, '');
const API_BASE = `${BASE_URL}/api`;

function defaultInit(extra?: RequestInit): RequestInit {
  return {
    credentials: 'include',
    ...extra,
    headers: {
      Accept: 'application/json',
      ...(extra?.headers ?? {}),
    },
  };
}

export class UnauthorizedError extends Error {
  constructor(message = 'unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

async function checkOk(res: Response): Promise<Response> {
  if (res.status === 401) {
    throw new UnauthorizedError('需要重新登录');
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body && typeof body === 'object' && 'error' in body) {
        msg = `${msg}: ${(body as { error: string }).error}`;
      }
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res;
}

export async function fetchMe(): Promise<UserPresence> {
  const res = await fetch(`${API_BASE}/me`, defaultInit());
  return (await checkOk(res)).json();
}

export async function fetchUsers(): Promise<{ users: UserPresence[] }> {
  const res = await fetch(`${API_BASE}/users`, defaultInit());
  return (await checkOk(res)).json();
}

export async function fetchThreads(): Promise<{ threads: Thread[] }> {
  const res = await fetch(`${API_BASE}/threads`, defaultInit());
  return (await checkOk(res)).json();
}

export async function createDm(peerUserId: string): Promise<{ thread: Thread }> {
  const res = await fetch(
    `${API_BASE}/threads/dm`,
    defaultInit({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peer_user_id: peerUserId }),
    }),
  );
  return (await checkOk(res)).json();
}

export async function listMessages(
  threadId: string,
  opts?: { before?: string; limit?: number },
): Promise<{ thread_id: string; messages: Message[]; next_before: string | null }> {
  const q = new URLSearchParams();
  if (opts?.before) q.set('before', opts.before);
  if (opts?.limit) q.set('limit', String(opts.limit));
  const url = `${API_BASE}/threads/${encodeURIComponent(threadId)}/messages${q.toString() ? `?${q}` : ''}`;
  const res = await fetch(url, defaultInit());
  return (await checkOk(res)).json();
}

export async function postMessage(
  threadId: string,
  body: PostMessageRequest,
): Promise<{ message: Message }> {
  const res = await fetch(
    `${API_BASE}/threads/${encodeURIComponent(threadId)}/messages`,
    defaultInit({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return (await checkOk(res)).json();
}

/** 清空线程全部聊天记录（大群需 admin）。 */
export async function clearThreadMessages(
  threadId: string,
): Promise<{ ok: boolean; thread_id: string; deleted_count: number }> {
  const res = await fetch(
    `${API_BASE}/threads/${encodeURIComponent(threadId)}/messages`,
    defaultInit({ method: 'DELETE' }),
  );
  return (await checkOk(res)).json();
}

export async function uploadFile(file: File): Promise<UploadResponse> {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(
    `${API_BASE}/uploads`,
    defaultInit({ method: 'POST', body: fd }),
  );
  return (await checkOk(res)).json();
}

// ─── Admin: whitelist 管理 ──────────────────────────────────────────────

export interface WhitelistEntry {
  email: string;
  display_name?: string;
  displayName?: string;
  user_id?: string | null;
  userId?: string | null;
  role: 'admin' | 'member';
  status: 'active' | 'disabled';
  addedBy: string;
  addedAt: number;
  updatedAt: number;
}

export async function listWhitelist(): Promise<WhitelistEntry[]> {
  const res = await fetch(`${API_BASE}/admin/whitelist`, defaultInit());
  const body = (await checkOk(res)).clone();
  const data = await body.json();
  return data.entries ?? [];
}

export async function addWhitelistEntry(input: {
  email: string;
  role?: 'admin' | 'member';
  display_name?: string;
}): Promise<WhitelistEntry> {
  const res = await fetch(`${API_BASE}/admin/whitelist`, defaultInit({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }));
  const data = await (await checkOk(res)).json();
  return data.entry;
}

export async function patchWhitelistEntry(
  email: string,
  patch: Partial<{ role: 'admin' | 'member'; status: 'active' | 'disabled'; display_name: string }>,
): Promise<WhitelistEntry> {
  const res = await fetch(
    `${API_BASE}/admin/whitelist/${encodeURIComponent(email)}`,
    defaultInit({
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  );
  const data = await (await checkOk(res)).json();
  return data.entry;
}

export async function removeWhitelistEntry(email: string): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/whitelist/${encodeURIComponent(email)}`,
    defaultInit({ method: 'DELETE' }),
  );
  await checkOk(res);
}

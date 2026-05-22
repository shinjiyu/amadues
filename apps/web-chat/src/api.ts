/**
 * 浏览器侧 REST 客户端。
 *
 * 通过 Vite dev proxy 把 `/api/*` 转发到 chat-server；生产部署可改 proxy/反代。
 * 每个请求都带 `X-User-Id` header（无认证）。
 */
import type {
  Message,
  Thread,
  UploadResponse,
  UserPresence,
  PostMessageRequest,
} from '@utlra/webchat-protocol';
import type { ClientIdentity } from './auth.js';

const API_BASE = '/api';

function headers(id: ClientIdentity, extra?: Record<string, string>): HeadersInit {
  return {
    'X-User-Id': id.user_id,
    ...(extra ?? {}),
  };
}

async function checkOk(res: Response): Promise<Response> {
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

export async function fetchMe(id: ClientIdentity): Promise<UserPresence> {
  const res = await fetch(
    `${API_BASE}/me?display_name=${encodeURIComponent(id.display_name)}`,
    { headers: headers(id) },
  );
  return (await checkOk(res)).json();
}

export async function fetchUsers(id: ClientIdentity): Promise<{ users: UserPresence[] }> {
  const res = await fetch(`${API_BASE}/users`, { headers: headers(id) });
  return (await checkOk(res)).json();
}

export async function fetchThreads(id: ClientIdentity): Promise<{ threads: Thread[] }> {
  const res = await fetch(`${API_BASE}/threads`, { headers: headers(id) });
  return (await checkOk(res)).json();
}

export async function createDm(id: ClientIdentity, peerUserId: string): Promise<{ thread: Thread }> {
  const res = await fetch(`${API_BASE}/threads/dm`, {
    method: 'POST',
    headers: headers(id, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ peer_user_id: peerUserId }),
  });
  return (await checkOk(res)).json();
}

export async function listMessages(
  id: ClientIdentity,
  threadId: string,
  opts?: { before?: string; limit?: number },
): Promise<{ thread_id: string; messages: Message[]; next_before: string | null }> {
  const q = new URLSearchParams();
  if (opts?.before) q.set('before', opts.before);
  if (opts?.limit) q.set('limit', String(opts.limit));
  const url = `${API_BASE}/threads/${encodeURIComponent(threadId)}/messages${q.toString() ? `?${q}` : ''}`;
  const res = await fetch(url, { headers: headers(id) });
  return (await checkOk(res)).json();
}

export async function postMessage(
  id: ClientIdentity,
  threadId: string,
  body: PostMessageRequest,
): Promise<{ message: Message }> {
  const res = await fetch(`${API_BASE}/threads/${encodeURIComponent(threadId)}/messages`, {
    method: 'POST',
    headers: headers(id, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  return (await checkOk(res)).json();
}

export async function uploadFile(id: ClientIdentity, file: File): Promise<UploadResponse> {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`${API_BASE}/uploads`, {
    method: 'POST',
    headers: headers(id),
    body: fd,
  });
  return (await checkOk(res)).json();
}

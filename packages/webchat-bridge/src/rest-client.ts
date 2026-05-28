/**
 * 适配器侧 chat-server REST 客户端（Node 端）。
 *
 * 与浏览器 `apps/web-chat/src/api.ts` 同形，但允许注入自定义 `fetchImpl`（测试用）。
 * 每次请求带 `X-User-Id` header（agent 的 user_id）；如果 `agentSecret` 已配置，
 * 仅 WS hello 用到，REST 不需要重复提交（hello 已经把连接对齐为 agent）。
 */
import type {
  Attachment,
  Message,
  PostMessageRequest,
  Thread,
  UserPresence,
} from '@utlra/webchat-protocol';
import type { WebChatBridgeConfig } from './config.js';

export interface RestClientOptions {
  config: WebChatBridgeConfig;
  fetchImpl?: typeof fetch;
}

export class WebChatRestClient {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: RestClientOptions) {
    this.fetchFn = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private url(path: string): string {
    return `${this.opts.config.apiBase}${path.startsWith('/') ? path : `/${path}`}`;
  }

  private headers(extra?: Record<string, string>): HeadersInit {
    const out: Record<string, string> = {
      'X-User-Id': this.opts.config.agentUserId,
    };
    if (this.opts.config.agentSecret) {
      // chat-server 开启 WEBCHAT_AUTH_REQUIRED=1 时，必须靠 Bearer secret 走 agent 旁路；
      // 不开启时多余的 header 也无害（middleware 仅在 agentSecret 命中时才升级 principal）。
      out['Authorization'] = `Bearer ${this.opts.config.agentSecret}`;
    }
    return { ...out, ...(extra ?? {}) };
  }

  private async checkOk(res: Response): Promise<Response> {
    if (res.ok) return res;
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json() as { error?: string };
      if (body?.error) detail = `${detail}: ${body.error}`;
    } catch { /* ignore */ }
    throw new Error(`webchat REST failed: ${detail}`);
  }

  async me(): Promise<UserPresence> {
    const res = await this.fetchFn(this.url(
      `/me?display_name=${encodeURIComponent(this.opts.config.agentDisplayName)}`,
    ), { headers: this.headers() });
    return (await this.checkOk(res)).json();
  }

  async listThreads(): Promise<{ threads: Thread[] }> {
    const res = await this.fetchFn(this.url('/threads'), { headers: this.headers() });
    return (await this.checkOk(res)).json();
  }

  /** 上传二进制到 chat-server，供出站 `attachment_ids` 使用。 */
  async uploadFile(
    bytes: Buffer,
    mime: string,
    name: string,
  ): Promise<Attachment> {
    const form = new FormData();
    const blob = new Blob([Uint8Array.from(bytes)], {
      type: mime || 'application/octet-stream',
    });
    form.append('file', blob, name || 'file');
    const res = await this.fetchFn(this.url('/uploads'), {
      method: 'POST',
      headers: this.headers(),
      body: form,
    });
    const body = (await (await this.checkOk(res)).json()) as {
      asset_id: string;
      url: string;
      mime: string;
      name: string;
      size: number;
    };
    return {
      asset_id: body.asset_id,
      url: body.url,
      mime: body.mime,
      name: body.name,
      size: body.size,
    };
  }

  async postMessage(threadId: string, body: PostMessageRequest): Promise<{ message: Message }> {
    const res = await this.fetchFn(this.url(`/threads/${encodeURIComponent(threadId)}/messages`), {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    return (await this.checkOk(res)).json();
  }

  /** 下载附件二进制（用于 mirror_assets 模式把 chat-server URL 落到 ChatAssetStore）。 */
  async downloadAttachment(att: Attachment): Promise<{ bytes: Buffer; mime: string; name: string } | null> {
    const url = absoluteAttachmentUrl(this.opts.config.apiBase, att.url);
    try {
      const res = await this.fetchFn(url, { headers: this.headers() });
      if (!res.ok) return null;
      const ab = await res.arrayBuffer();
      return { bytes: Buffer.from(ab), mime: att.mime, name: att.name };
    } catch (e) {
      console.warn('[webchat-bridge] downloadAttachment failed', url, e);
      return null;
    }
  }
}

export function absoluteAttachmentUrl(apiBase: string, url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/')) return `${apiBase}${url}`;
  return `${apiBase}/${url}`;
}

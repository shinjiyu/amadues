import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  CreateDmRequestSchema,
  ListMessagesQuerySchema,
  PostMessageRequestSchema,
  type Attachment,
} from '@utlra/webchat-protocol';
import { identityMiddleware } from '../identity-mw.js';
import type { UserStore } from '../users.js';
import type { ThreadStore } from '../threads.js';
import type { UploadStore } from '../uploads.js';
import type { WsHub } from '../ws-hub.js';
import { buildParts } from '../parts-builder.js';

export interface ThreadsRouterDeps {
  users: UserStore;
  threads: ThreadStore;
  uploads: UploadStore;
  hub: WsHub;
  maxMessagesPerPage: number;
  /** 子路径部署时附件 url 的前缀（不含尾斜杠），如 `/webchat`。 */
  publicBasePath?: string;
}

export function buildThreadsRouter(deps: ThreadsRouterDeps): Hono {
  const { users, threads, uploads, hub, maxMessagesPerPage } = deps;
  const basePrefix = deps.publicBasePath ?? '';
  const r = new Hono();
  const auth = identityMiddleware(users);

  r.get('/threads', auth, (c) => {
    const userId = c.get('userId');
    return c.json({ threads: threads.listVisible(userId) });
  });

  r.post('/threads/dm', auth, async (c) => {
    const userId = c.get('userId');
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateDmRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HTTPException(400, { message: `invalid body: ${parsed.error.message}` });
    }
    const peer = parsed.data.peer_user_id;
    if (peer === userId) {
      throw new HTTPException(400, { message: 'cannot DM yourself' });
    }
    if (!users.get(peer)) {
      throw new HTTPException(404, { message: `peer user not found: ${peer}` });
    }
    const thread = await threads.getOrCreateDm(userId, peer);
    return c.json({ thread });
  });

  r.get('/threads/:id/messages', auth, async (c) => {
    const userId = c.get('userId');
    const threadId = c.req.param('id') ?? '';
    if (!threadId || !threads.canAccess(threadId, userId)) {
      throw new HTTPException(403, { message: 'not a participant of this thread' });
    }
    const qParsed = ListMessagesQuerySchema.safeParse({
      before: c.req.query('before'),
      limit: c.req.query('limit'),
    });
    if (!qParsed.success) {
      throw new HTTPException(400, { message: qParsed.error.message });
    }
    const limit = Math.min(qParsed.data.limit ?? 50, maxMessagesPerPage);
    const { messages, next_before } = await threads.listMessages(threadId, qParsed.data.before, limit);
    return c.json({ thread_id: threadId, messages, next_before });
  });

  r.post('/threads/:id/messages', auth, async (c) => {
    const userId = c.get('userId');
    const threadId = c.req.param('id') ?? '';
    if (!threadId || !threads.canAccess(threadId, userId)) {
      throw new HTTPException(403, { message: 'not a participant of this thread' });
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = PostMessageRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HTTPException(400, { message: parsed.error.message });
    }
    const req = parsed.data;

    if (req.reply_to_message_id) {
      const found = await threads.findMessage(threadId, req.reply_to_message_id);
      if (!found) {
        throw new HTTPException(404, {
          message: `reply_to_message_id not found: ${req.reply_to_message_id}`,
        });
      }
    }

    const attachments: Attachment[] = [];
    for (const aid of req.attachment_ids ?? []) {
      const meta = uploads.get(aid);
      if (!meta) {
        throw new HTTPException(400, { message: `attachment not found: ${aid}` });
      }
      attachments.push({
        asset_id: meta.asset_id,
        url: `${basePrefix}/uploads/${meta.asset_id}`,
        mime: meta.mime,
        name: meta.original_name,
        size: meta.size,
      });
    }

    const built = buildParts({
      text: req.text,
      parts: req.parts,
      mentionUserIds: req.mention_user_ids ?? [],
      attachments,
      resolveUser: (uid) => users.get(uid),
    });

    const message = await threads.appendMessage({
      thread_id: threadId,
      sender_user_id: userId,
      parts: built.parts,
      text: built.text,
      mentions: built.mentions,
      attachments,
      ...(req.reply_to_message_id ? { reply_to_message_id: req.reply_to_message_id } : {}),
    });

    hub.notifyNewMessage(message, req.client_msg_id, userId);

    return c.json({ message });
  });

  return r;
}

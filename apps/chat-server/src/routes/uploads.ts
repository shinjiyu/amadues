import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { stream } from 'hono/streaming';
import { Readable } from 'node:stream';
import { identityMiddleware } from '../identity-mw.js';
import type { UserStore } from '../users.js';
import type { UploadStore } from '../uploads.js';

export interface UploadsRouterDeps {
  users: UserStore;
  uploads: UploadStore;
  maxUploadSize: number;
}

export function buildUploadsRouter(deps: UploadsRouterDeps): Hono {
  const { users, uploads, maxUploadSize } = deps;
  const r = new Hono();

  r.post('/uploads', identityMiddleware(users), async (c) => {
    const userId = c.get('userId');
    const formData = await c.req.formData().catch(() => null);
    if (!formData) {
      throw new HTTPException(400, { message: 'multipart/form-data required' });
    }
    const fileEntry = formData.get('file');
    if (!fileEntry || typeof fileEntry === 'string') {
      throw new HTTPException(400, { message: 'field `file` missing' });
    }
    const file = fileEntry as File;
    if (file.size > maxUploadSize) {
      throw new HTTPException(413, {
        message: `file too large: ${file.size} > ${maxUploadSize}`,
      });
    }
    const ab = await file.arrayBuffer();
    const bytes = Buffer.from(ab);
    const meta = await uploads.save({
      bytes,
      originalName: file.name || 'unnamed',
      mime: file.type || 'application/octet-stream',
      uploaderUserId: userId,
    });
    return c.json({
      asset_id: meta.asset_id,
      url: `/uploads/${meta.asset_id}`,
      mime: meta.mime,
      name: meta.original_name,
      size: meta.size,
    });
  });

  /** 下载附件。开放访问（凭 asset_id UUID 防遍历）；不带 identity 中间件以便 H5 <img src=…> 加载。 */
  r.get('/uploads/:asset_id', async (c) => {
    const id = c.req.param('asset_id');
    const meta = uploads.get(id);
    if (!meta) {
      throw new HTTPException(404, { message: 'asset not found' });
    }
    c.header('Content-Type', meta.mime);
    c.header('Content-Length', String(meta.size));
    c.header(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(meta.original_name)}"`,
    );
    const nodeStream = uploads.openReadStream(meta);
    return stream(c, async (s) => {
      const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;
      await s.pipe(webStream);
    });
  });

  return r;
}

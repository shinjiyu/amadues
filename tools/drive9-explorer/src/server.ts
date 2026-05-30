/**
 * Drive9 Explorer API — 本地代理，避免浏览器暴露 API Key。
 * 默认端口 7780；前端 Vite 7782。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  getDrive9Client,
  resolveDrive9Config,
  type FileEntry,
  type SearchResult,
} from '../../../packages/server/src/drive9/drive9-client.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.join(__dir, '..', 'web', 'dist');

const app = new Hono();

app.use(
  '/*',
  cors({
    origin: ['http://localhost:7782', 'http://127.0.0.1:7782'],
  }),
);

function clientOrError(c: { json: (body: unknown, status?: number) => Response }) {
  const cfg = resolveDrive9Config();
  const client = getDrive9Client();
  if (!client || !cfg) {
    return {
      error: c.json(
        {
          ok: false,
          error:
            'Drive9 未配置。请设置 DRIVE9_API_KEY 环境变量，或配置 ~/.drive9/config 当前 context。',
        },
        503,
      ),
    };
  }
  return { client, cfg };
}

app.get('/api/status', (c) => {
  const cfg = resolveDrive9Config();
  const client = getDrive9Client();
  return c.json({
    ok: !!client,
    source: cfg?.source ?? null,
    contextName: cfg?.contextName ?? null,
    apiUrl: cfg?.apiUrl ?? 'https://api.drive9.ai',
  });
});

app.get('/api/list', async (c) => {
  const r = clientOrError(c);
  if ('error' in r) return r.error;
  const dirPath = c.req.query('path') ?? '/';
  try {
    const entries: FileEntry[] = await r.client.list(dirPath);
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return c.json({ ok: true, path: dirPath, entries });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

app.get('/api/read', async (c) => {
  const r = clientOrError(c);
  if ('error' in r) return r.error;
  const filePath = c.req.query('path');
  if (!filePath) return c.json({ ok: false, error: 'path required' }, 400);
  try {
    const content = await r.client.read(filePath);
    return c.json({ ok: true, path: filePath, content });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

app.put('/api/write', async (c) => {
  const r = clientOrError(c);
  if ('error' in r) return r.error;
  const body = (await c.req.json()) as { path?: string; content?: string };
  if (!body.path || body.content === undefined) {
    return c.json({ ok: false, error: 'path and content required' }, 400);
  }
  try {
    await r.client.write(body.path, body.content);
    return c.json({ ok: true, path: body.path });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

app.delete('/api/delete', async (c) => {
  const r = clientOrError(c);
  if ('error' in r) return r.error;
  const filePath = c.req.query('path');
  if (!filePath) return c.json({ ok: false, error: 'path required' }, 400);
  try {
    await r.client.delete(filePath);
    return c.json({ ok: true, path: filePath });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

app.get('/api/search', async (c) => {
  const r = clientOrError(c);
  if ('error' in r) return r.error;
  const q = c.req.query('q')?.trim();
  if (!q) return c.json({ ok: false, error: 'q required' }, 400);
  const prefix = c.req.query('prefix') ?? '/';
  const limit = Number(c.req.query('limit') ?? 30);
  try {
    const results: SearchResult[] = await r.client.grep(q, prefix, limit);
    return c.json({ ok: true, query: q, prefix, results });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

// 生产静态托管
if (fs.existsSync(WEB_DIST)) {
  app.get('/', (c) => {
    const html = fs.readFileSync(path.join(WEB_DIST, 'index.html'), 'utf8');
    return c.html(html);
  });
  app.get('/assets/:file', (c) => {
    const file = c.req.param('file');
    const fp = path.join(WEB_DIST, 'assets', file);
    if (!fs.existsSync(fp)) return c.text('not found', 404);
    const buf = fs.readFileSync(fp);
    const mime = file.endsWith('.css')
      ? 'text/css'
      : file.endsWith('.js')
        ? 'application/javascript'
        : 'application/octet-stream';
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' },
    });
  });
}

const port = Number(process.env['DRIVE9_EXPLORER_PORT'] ?? 7780);
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  const cfg = resolveDrive9Config();
  console.log(
    `[drive9-explorer] http://127.0.0.1:${info.port}  drive9=${cfg ? 'connected' : 'NOT CONFIGURED'}`,
  );
});

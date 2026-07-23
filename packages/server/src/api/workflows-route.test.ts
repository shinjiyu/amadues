import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { ExecutableWorkflowStore } from '../outer/executable-workflow-store.js';
import type { ExecutableWorkflow } from '../outer/executable-workflow-types.js';
import { registerWorkflowsRoute } from './workflows-route.js';

function sample(id: string): ExecutableWorkflow {
  return {
    id,
    version: '1',
    kind: 'shell_pipeline',
    title: `WF ${id}`,
    tags: ['kpi:demo'],
    entry: 's1',
    steps: [{ id: 's1', action: 'assert', expect: { note: 'ok' } }],
    failurePolicy: { onStepFail: 'abort_escalate', maxRetries: 0 },
    source: { promotedAt: '2026-07-23T00:00:00.000Z' },
  };
}

describe('workflows-route', () => {
  let root: string;

  afterEach(() => {
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('GET /api/workflows 列出 meta；GET :id 返回 body', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-api-'));
    const store = new ExecutableWorkflowStore({ dataRoot: root });
    store.put(sample('ew-a'));
    store.put({ ...sample('ew-b'), tags: ['other'] });

    const app = new Hono();
    registerWorkflowsRoute(app, root);

    const list = await app.request('/api/workflows');
    expect(list.status).toBe(200);
    const lj = (await list.json()) as { count: number; workflows: { id: string }[] };
    expect(lj.count).toBe(2);
    expect(lj.workflows.map((w) => w.id).sort()).toEqual(['ew-a', 'ew-b']);

    const tagged = await app.request('/api/workflows?tag=kpi:demo');
    const tj = (await tagged.json()) as { count: number };
    expect(tj.count).toBe(1);

    const one = await app.request('/api/workflows/ew-a');
    expect(one.status).toBe(200);
    const oj = (await one.json()) as { workflow: { title: string }; meta: { latestVersion: string } };
    expect(oj.workflow.title).toBe('WF ew-a');
    expect(oj.meta.latestVersion).toBe('1');

    const missing = await app.request('/api/workflows/nope');
    expect(missing.status).toBe(404);
  });
});

/**
 * Executable Workflow 只读 HTTP — Dashboard 列表/详情
 * @see doc/structurizr/EXECUTABLE-WORKFLOW.md §9 / P1
 */
import type { Hono } from 'hono';
import { ExecutableWorkflowStore } from '../outer/executable-workflow-store.js';

export function registerWorkflowsRoute(app: Hono, dataRoot: string): void {
  const store = new ExecutableWorkflowStore({ dataRoot });

  app.get('/api/workflows', (c) => {
    const tag = c.req.query('tag')?.trim();
    let workflows = store.list();
    if (tag) {
      workflows = workflows.filter((m) => m.tags.includes(tag));
    }
    return c.json({
      dataRoot,
      count: workflows.length,
      workflows,
    });
  });

  app.get('/api/workflows/:id', (c) => {
    const id = c.req.param('id').trim();
    if (!id) return c.json({ error: 'id required' }, 400);
    const version = c.req.query('version')?.trim();
    const meta = store.getMeta(id);
    if (!meta) return c.json({ error: 'not found' }, 404);
    const wf = version
      ? store.get({ id, version })
      : store.getLatest(id);
    if (!wf) return c.json({ error: 'version not found', meta }, 404);
    return c.json({ meta, workflow: wf });
  });
}

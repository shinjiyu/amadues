import { describe, expect, it, vi } from 'vitest';
import {
  WorkflowDrive9Store,
  deserializeWorkflow,
  serializeWorkflow,
  workflowDrive9Path,
} from './workflow-drive9-store.js';
import type { Drive9Client } from './drive9-client.js';
import type { ExecutableWorkflow } from '../outer/executable-workflow-types.js';

const sample = (): ExecutableWorkflow => ({
  id: 'ew-d9',
  version: '2',
  kind: 'shell_pipeline',
  title: 'T',
  tags: ['kpi:abc'],
  entry: 's1',
  steps: [{ id: 's1', action: 'assert', expect: { fileExists: 'a.txt' } }],
  failurePolicy: { onStepFail: 'abort_escalate', maxRetries: 1 },
  source: { promotedAt: '2026-07-23T00:00:00.000Z' },
});

describe('workflow-drive9-store', () => {
  it('path + serialize roundtrip', () => {
    expect(workflowDrive9Path('ew-d9', '2')).toBe('/workflows/shared/ew-d9@2.json');
    const raw = serializeWorkflow(sample());
    const back = deserializeWorkflow(raw, 'ew-d9');
    expect(back.version).toBe('2');
    expect(back.steps).toHaveLength(1);
  });

  it('storeSharedAwait / getShared / listShared', async () => {
    const files = new Map<string, string>();
    const client = {
      write: vi.fn(async (p: string, c: string) => {
        files.set(p, c);
      }),
      read: vi.fn(async (p: string) => {
        const v = files.get(p);
        if (!v) throw new Error('404');
        return v;
      }),
      list: vi.fn(async () =>
        [...files.keys()].map((p) => ({
          name: p.split('/').pop()!,
          size: 1,
          isDir: false,
        })),
      ),
    } as unknown as Drive9Client;

    const store = new WorkflowDrive9Store(client);
    await store.storeSharedAwait(sample());
    expect(files.has('/workflows/shared/ew-d9@2.json')).toBe(true);
    const got = await store.getShared('ew-d9', '2');
    expect(got?.title).toBe('T');
    const list = await store.listShared();
    expect(list.some((x) => x.id === 'ew-d9' && x.version === '2')).toBe(true);
  });
});

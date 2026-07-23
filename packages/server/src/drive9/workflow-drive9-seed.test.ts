import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutableWorkflowStore } from '../outer/executable-workflow-store.js';
import type { ExecutableWorkflow } from '../outer/executable-workflow-types.js';
import { WorkflowDrive9Store } from './workflow-drive9-store.js';
import type { Drive9Client } from './drive9-client.js';
import { resolveWorkflowWithDrive9, seedWorkflowsFromDrive9 } from './workflow-drive9-seed.js';

const sample = (id = 'ew-seed', version = '1'): ExecutableWorkflow => ({
  id,
  version,
  kind: 'shell_pipeline',
  title: 'Seed',
  tags: [],
  entry: 's1',
  steps: [{ id: 's1', action: 'assert', expect: { fileExists: 'a.txt' } }],
  failurePolicy: { onStepFail: 'abort_escalate', maxRetries: 0 },
  source: { promotedAt: '2026-07-23T00:00:00.000Z' },
});

describe('workflow-drive9-seed', () => {
  let root: string;

  afterEach(() => {
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  function mockRemote(files: Map<string, string>): WorkflowDrive9Store {
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
    return new WorkflowDrive9Store(client);
  }

  it('seedWorkflowsFromDrive9 imports missing versions', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-seed-'));
    const local = new ExecutableWorkflowStore({ dataRoot: root });
    const files = new Map<string, string>();
    const remote = mockRemote(files);
    await remote.storeSharedAwait(sample('ew-a', '1'));
    await remote.storeSharedAwait(sample('ew-b', '2'));
    local.put(sample('ew-a', '1')); // already present → skip

    const r = await seedWorkflowsFromDrive9(remote, local);
    expect(r.imported).toBe(1);
    expect(r.skipped).toBe(1);
    expect(local.get({ id: 'ew-b', version: '2' })?.title).toBe('Seed');
  });

  it('resolveWorkflowWithDrive9 pulls on miss', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-seed-'));
    const local = new ExecutableWorkflowStore({ dataRoot: root });
    const files = new Map<string, string>();
    const remote = mockRemote(files);
    await remote.storeSharedAwait(sample('ew-miss', '3'));

    expect(local.get({ id: 'ew-miss', version: '3' })).toBeNull();
    const wf = await resolveWorkflowWithDrive9(local, { id: 'ew-miss', version: '3' }, remote);
    expect(wf?.version).toBe('3');
    expect(local.get({ id: 'ew-miss', version: '3' })?.id).toBe('ew-miss');
  });
});

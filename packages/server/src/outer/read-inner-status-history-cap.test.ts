/**
 * read_inner_status include_history 截断（经 executeOuterTool）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FilesystemWorkspaceStore } from '../workspace-kit/index.js';
import { InnerBrainRegistry, type TaskRecord } from './inner-brain-registry.js';
import { executeOuterTool, type OuterToolContext } from './outer-tools.js';

describe('read_inner_status history cap', () => {
  let root: string;
  const prevCap = process.env['UTLRA_INNER_STATUS_HISTORY_CAP'];

  afterEach(() => {
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
    if (prevCap === undefined) delete process.env['UTLRA_INNER_STATUS_HISTORY_CAP'];
    else process.env['UTLRA_INNER_STATUS_HISTORY_CAP'] = prevCap;
  });

  it('returns truncated=true when include_history exceeds cap', async () => {
    process.env['UTLRA_INNER_STATUS_HISTORY_CAP'] = '2';
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-hist-cap-'));
    const registry = new InnerBrainRegistry(root);
    for (let i = 0; i < 5; i++) {
      const id = `ib-h${i}`;
      const rec: TaskRecord = {
        instanceId: id,
        workspaceId: `task-${id}`,
        workDir: path.join(root, 'workspaces', `task-${id}`),
        goal: 'g',
        originUser: 'u',
        status: 'DONE',
        startedAt: `2026-07-${String(20 - i).padStart(2, '0')}T00:00:00.000Z`,
        finishedAt: `2026-07-${String(20 - i).padStart(2, '0')}T01:00:00.000Z`,
      };
      registry.register(rec);
    }
    const ctx: OuterToolContext = {
      threadId: 't1',
      agentSid: 'agent:test',
      workspaceId: 'ws-outer',
      imClient: {} as OuterToolContext['imClient'],
      assetStore: {} as OuterToolContext['assetStore'],
      getEngine: () => ({ readStatus: () => null } as never),
      workspaceStore: new FilesystemWorkspaceStore(path.join(root, 'workspaces')),
      repoStore: {} as OuterToolContext['repoStore'],
      dataRoot: root,
      innerBrainRegistry: registry,
    };
    const result = await executeOuterTool(
      'read_inner_status',
      JSON.stringify({ include_history: 'true' }),
      ctx,
    );
    const body = JSON.parse(result.output) as {
      listed: number;
      registry_total: number;
      truncated: boolean;
      history_cap: number;
      scope: string;
    };
    expect(body.scope).toBe('all');
    expect(body.listed).toBe(2);
    expect(body.registry_total).toBe(5);
    expect(body.truncated).toBe(true);
    expect(body.history_cap).toBe(2);
  });
});

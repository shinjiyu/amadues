import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDataRoot } from '../testing/temp-data-root.js';
import { dispatchAdHocBurst } from './ad-hoc-burst-allocator.js';
import * as outerTools from './outer-tools.js';
import { ChatAssetStore } from '@utlra/chat-ir';
import { InnerBrainRegistry } from './inner-brain-registry.js';
import {
  FilesystemRepositoryStore,
  FilesystemWorkspaceStore,
  InnerBrainEngine,
} from '../workspace-kit/index.js';

describe('dispatchAdHocBurst', () => {
  let root: ReturnType<typeof createTestDataRoot>;

  afterEach(() => {
    vi.restoreAllMocks();
    root?.cleanup();
  });

  it('调用 set_goal 且无 kpi_id', async () => {
    root = createTestDataRoot('adhoc-');
    const spy = vi.spyOn(outerTools, 'executeOuterTool').mockResolvedValue({
      replied: false,
      output: '已创建新内脑实例并启动任务 instance_id=ib-adhoc-1',
    });

    const workspaces = path.join(root.dataRoot, 'workspaces');
    fs.mkdirSync(workspaces, { recursive: true });
    const store = new FilesystemWorkspaceStore(workspaces);
    const engines = new Map<string, InnerBrainEngine>();

    const r = await dispatchAdHocBurst(
      root.dataRoot,
      {
        threadId: 'thread-1',
        agentSid: 'agent:test',
        workspaceId: 'default',
        repoRoot: root.dataRoot,
        imClient: { postMessage: async () => {} } as never,
        assetStore: new ChatAssetStore(path.join(root.dataRoot, 'uploads')),
        getEngine: (wsId) => {
          let e = engines.get(wsId);
          if (!e) {
            e = new InnerBrainEngine(store, wsId);
            engines.set(wsId, e);
          }
          return e;
        },
        workspaceStore: store,
        repoStore: new FilesystemRepositoryStore(root.dataRoot),
        dataRoot: root.dataRoot,
        innerBrainRegistry: new InnerBrainRegistry(root.dataRoot),
      },
      {
        goal: '帮我查天气',
        originUser: 'human:u1',
        originThread: 'thread-1',
        workspaceId: 'default',
      },
    );

    expect(r.ok).toBe(true);
    expect(r.instanceId).toBe('ib-adhoc-1');
    expect(spy).toHaveBeenCalledWith(
      'set_goal',
      expect.not.stringContaining('kpi_id'),
      expect.objectContaining({ inboundHumanSid: 'human:u1' }),
    );

    const tasks = JSON.parse(
      fs.readFileSync(path.join(root.dataRoot, 'ad-hoc-tasks.json'), 'utf8'),
    ) as { status: string }[];
    expect(tasks.some((t) => t.status === 'running')).toBe(true);
  });
});

/**
 * Agent 栈测试夹具：dataRoot + KpiRegistry + InnerBrainRegistry + FakeIm。
 */
import path from 'node:path';

import type { InnerBrainEngine } from '../workspace-kit/index.js';

import { InnerBrainRegistry, type TaskRecord } from '../outer/inner-brain-registry.js';
import { countDeliverables } from '../outer/inner-burst-exit.js';
import { createTestDataRoot, type TestDataRoot } from './temp-data-root.js';
import { FakeImChannel } from './fake-im-channel.js';
import { writeSyntheticWorkspace, type SyntheticWorkspaceOpts } from './workspace-factory.js';

export interface AgentStackFixture extends TestDataRoot {
  innerBrainRegistry: InnerBrainRegistry;
  im: FakeImChannel;
  simulateBurstExit(
    opts: SyntheticWorkspaceOpts & {
      verdict?: 'success' | 'partial' | 'failed';
      stoppedBy?: 'idle' | 'max_ticks' | 'stop_signal';
      exitedWithError?: boolean;
    },
  ): {
    instanceId: string;
    workDir: string;
    deliverableCount: number;
    task: TaskRecord;
  };
}

export function createAgentStackFixture(): AgentStackFixture {
  const root = createTestDataRoot('kuroneko-agent-stack-');
  const innerBrainRegistry = new InnerBrainRegistry(root.dataRoot);
  const im = new FakeImChannel();

  return {
    ...root,
    innerBrainRegistry,
    im,
    simulateBurstExit(opts) {
      const instanceId = innerBrainRegistry.generateInstanceId();
      const workspaceId = `task-${instanceId}`;
      const workDir = path.join(root.workspacesDir, workspaceId);
      writeSyntheticWorkspace(workDir, opts);

      const deliverables = opts.deliverables ?? [];
      const asyncWaiting = opts.asyncWaiting ?? false;
      const task: TaskRecord = {
        instanceId,
        workspaceId,
        workDir,
        goal: opts.goal ?? '测试',
        originUser: 'test:user',
        originThread: 'thread:test',
        status: asyncWaiting ? 'AWAITING' : 'DONE',
        startedAt: new Date().toISOString(),
        finishedAt: asyncWaiting ? undefined : new Date().toISOString(),
        deliverableCount: deliverables.length,
      };
      innerBrainRegistry.register(task);

      return {
        instanceId,
        workDir,
        deliverableCount: countDeliverables(workDir),
        task,
      };
    },
  };
}

export function createNoopEngine(): InnerBrainEngine {
  return {
    setDeliverables: () => {},
    readStatus: () => null,
    setGoal: () => {},
  } as unknown as InnerBrainEngine;
}

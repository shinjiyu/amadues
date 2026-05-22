/**
 * Agent 栈测试夹具：dataRoot + KpiRegistry + InnerBrainRegistry + FakeIm。
 *
 * 覆盖「外脑编排层」可测部分，不启动真实 LLM / 内脑子进程。
 */
import path from 'node:path';

import type { InnerBrainEngine } from '../workspace-kit/index.js';

import { KpiRegistry } from '../outer/kpi-registry.js';
import { InnerBrainRegistry, type TaskRecord } from '../outer/inner-brain-registry.js';
import {
  processBurstExitForKpi,
  type BurstExitDeps,
  type BurstExitInput,
} from '../outer/kpi-burst-hooks.js';
import { createTestDataRoot, type TestDataRoot } from './temp-data-root.js';
import { FakeImChannel } from './fake-im-channel.js';
import { writeSyntheticWorkspace, type SyntheticWorkspaceOpts } from './workspace-factory.js';

export interface AgentStackFixture extends TestDataRoot {
  kpiRegistry: KpiRegistry;
  innerBrainRegistry: InnerBrainRegistry;
  im: FakeImChannel;
  reflexionBurstsScheduled: string[];
  /** 注册 KPI 并返回 kpiId */
  createKpi(description: string): string;
  /** 模拟一次 burst 结束（写 workspace + 跑 KPI hook） */
  simulateBurstExit(
    kpiId: string,
    opts: SyntheticWorkspaceOpts & {
      /** 简写：等价于 reflexion.verdict */
      verdict?: 'success' | 'partial' | 'failed';
      stoppedBy?: BurstExitInput['stoppedBy'];
      exitedWithError?: boolean;
      isReflexionBurst?: boolean;
    },
  ): {
    instanceId: string;
    workDir: string;
    outcome: ReturnType<typeof processBurstExitForKpi>;
    task: TaskRecord;
  };
}

export function createAgentStackFixture(): AgentStackFixture {
  const root = createTestDataRoot('kuroneko-agent-stack-');
  const kpiRegistry = new KpiRegistry(root.dataRoot);
  const innerBrainRegistry = new InnerBrainRegistry(root.dataRoot);
  const im = new FakeImChannel();
  const reflexionBurstsScheduled: string[] = [];

  const burstDeps: BurstExitDeps = {
    kpiRegistry,
    innerBrainRegistry,
    scheduleReflexionBurst: (kid) => {
      reflexionBurstsScheduled.push(kid);
      return `ib-reflexion-${reflexionBurstsScheduled.length}`;
    },
    stuckThreshold: 3,
  };

  const fixture: AgentStackFixture = {
    ...root,
    kpiRegistry,
    innerBrainRegistry,
    im,
    reflexionBurstsScheduled,
    createKpi(description) {
      return kpiRegistry.create({ description, createdBy: 'test:harness' }).kpiId;
    },
    simulateBurstExit(kpiId, opts) {
      const instanceId = innerBrainRegistry.generateInstanceId();
      const workspaceId = `task-${instanceId}`;
      const workDir = path.join(root.workspacesDir, workspaceId);
      const wsOpts: SyntheticWorkspaceOpts = {
        ...opts,
        reflexion: opts.reflexion ?? (opts.verdict ? { verdict: opts.verdict } : undefined),
      };
      writeSyntheticWorkspace(workDir, wsOpts);

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
        kpiId,
        deliverableCount: deliverables.length,
        isReflexionBurst: opts.isReflexionBurst ?? false,
      };
      innerBrainRegistry.register(task);
      kpiRegistry.attachBurst(kpiId, instanceId);

      const outcome = processBurstExitForKpi(
        {
          instanceId,
          kpiId,
          workDir,
          stoppedBy: opts.stoppedBy ?? 'idle',
          exitedWithError: opts.exitedWithError ?? false,
          isAwaiting: asyncWaiting,
          isReflexionBurst: opts.isReflexionBurst ?? false,
        },
        burstDeps,
      );

      innerBrainRegistry.update(instanceId, {
        status: asyncWaiting ? 'AWAITING' : 'DONE',
        deliverableCount: outcome.deliverableCount,
      });

      return { instanceId, workDir, outcome, task };
    },
  };

  return fixture;
}

/** 测试用最小 InnerBrainEngine 替身（setDeliverables + readStatus） */
export function createNoopEngine(): InnerBrainEngine {
  return {
    setDeliverables: () => {},
    readStatus: () => null,
    setGoal: () => {},
  } as unknown as InnerBrainEngine;
}

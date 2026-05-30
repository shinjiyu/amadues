import { afterEach, describe, expect, it, vi } from 'vitest';

import { IdentityRegistry, MessageRecordSchema } from '@utlra/chat-ir';
import path from 'node:path';
import { createTestDataRoot } from '../testing/temp-data-root.js';
import { InnerBrainRegistry } from './inner-brain-registry.js';
import { KpiRegistry } from './kpi-registry.js';
import { patchAutonomyPolicy } from './autonomy-policy-store.js';
import { savePersonality } from './personality.js';
import { dispatchAutonomyTasks, type AutonomyDispatchDeps } from './autonomy-task-dispatcher.js';
import type { AutonomyVerdict, ResourceSnapshot } from './autonomy-types.js';
import * as llmRaw from '../llm/raw.js';
import * as outerTools from './outer-tools.js';

function idleVerdict(): AutonomyVerdict {
  return { level: 'idle', reasons: ['hard_gates_pass'], judgedAt: new Date().toISOString() };
}

function baseSnapshot(): ResourceSnapshot {
  return {
    capturedAt: new Date().toISOString(),
    agentId: 'agent-test',
    innerBrains: { running: 0, awaiting: 0, blocked: 0, asyncWaiting: 0 },
    llm: { inFlight: 0, tokensLast1h: { prompt: 0, completion: 0, total: 0 }, callsLast1h: 0 },
    inbound: { orchestratorQueuedTotal: 0, outerLoopActiveThreads: 0 },
    im: { lastProactiveSpeakAt: null, proactiveCount5min: 0 },
    process: { heapUsedMb: 100, rssMb: 200 },
  };
}

describe('autonomy-task-dispatcher', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('busy verdict → no dispatch', async () => {
    const root = createTestDataRoot('aut-disp-');
    const registry = new InnerBrainRegistry(root.dataRoot);
    const kpiRegistry = new KpiRegistry(root.dataRoot);
    const deps: AutonomyDispatchDeps = {
      dataRoot: root.dataRoot,
      agentSid: 'agent-test',
      workspaceId: 'default',
      defaultThreadId: 'thread-1',
      registry,
      kpiRegistry,
      imClient: null,
      toolCtx: {} as AutonomyDispatchDeps['toolCtx'],
      getLlmEnv: () => null,
    };
    const result = await dispatchAutonomyTasks(deps, baseSnapshot(), {
      level: 'busy',
      reasons: ['llm_in_flight'],
      blockedByHardGate: 'llm_in_flight=2',
      judgedAt: new Date().toISOString(),
    });
    expect(result.dispatched).toBe(false);
    expect(result.reason).toBe('llm_in_flight=2');
    root.cleanup();
  });

  it('has active KPI → dispatches kpi_inner_goal when set_goal succeeds', async () => {
    const root = createTestDataRoot('aut-kpi-');
    patchAutonomyPolicy(root.dataRoot, { enabled: true });
    const registry = new InnerBrainRegistry(root.dataRoot);
    const kpiRegistry = new KpiRegistry(root.dataRoot);
    kpiRegistry.create({ description: '测试 KPI', createdBy: 'test' });

    vi.spyOn(llmRaw, 'llmRawChatCompletion').mockResolvedValue({
      raw: { choices: [{ message: { content: '执行 KPI 探测任务' } }] },
      status: 200,
    });
    vi.spyOn(outerTools, 'executeOuterTool').mockResolvedValue({
      replied: false,
      output: '已向内脑派发任务 instance-abc',
    });

    const deps: AutonomyDispatchDeps = {
      dataRoot: root.dataRoot,
      agentSid: 'agent-test',
      workspaceId: 'default',
      defaultThreadId: '',
      registry,
      kpiRegistry,
      imClient: null,
      toolCtx: {
        dataRoot: root.dataRoot,
        innerBrainRegistry: registry,
        kpiRegistry,
      } as AutonomyDispatchDeps['toolCtx'],
      getLlmEnv: () => ({
        provider: 'kimi',
        apiKey: 'test',
        baseUrl: 'http://localhost',
        textModel: 'test-model',
      }),
    };

    const result = await dispatchAutonomyTasks(deps, baseSnapshot(), idleVerdict());
    expect(result.dispatched).toBe(true);
    expect(result.taskType).toBe('kpi_inner_goal');
    root.cleanup();
  });

  it('skips kpi_inner_goal when same KPI already RUNNING', async () => {
    const root = createTestDataRoot('aut-kpi-dup-');
    patchAutonomyPolicy(root.dataRoot, { enabled: true });
    const registry = new InnerBrainRegistry(root.dataRoot);
    const kpiRegistry = new KpiRegistry(root.dataRoot);
    const kpi = kpiRegistry.create({ description: '测试 KPI', createdBy: 'test' });

    registry.register({
      instanceId: 'ib-running-dup',
      workspaceId: 'task-ib-running-dup',
      workDir: `${root.dataRoot}/workspaces/task-ib-running-dup`,
      goal: '已在跑的任务',
      originUser: 'test',
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
      kpiId: kpi.kpiId,
    });
    kpiRegistry.attachBurst(kpi.kpiId, 'ib-running-dup');

    const setGoalSpy = vi.spyOn(outerTools, 'executeOuterTool').mockResolvedValue({
      replied: false,
      output: '已向内脑派发任务 instance-should-not',
    });

    const deps: AutonomyDispatchDeps = {
      dataRoot: root.dataRoot,
      agentSid: 'agent-test',
      workspaceId: 'default',
      defaultThreadId: '',
      registry,
      kpiRegistry,
      imClient: null,
      toolCtx: {
        dataRoot: root.dataRoot,
        innerBrainRegistry: registry,
        kpiRegistry,
      } as AutonomyDispatchDeps['toolCtx'],
      getLlmEnv: () => ({
        provider: 'kimi',
        apiKey: 'test',
        baseUrl: 'http://localhost',
        textModel: 'test-model',
      }),
    };

    const result = await dispatchAutonomyTasks(deps, baseSnapshot(), idleVerdict());
    expect(result.dispatched).toBe(false);
    expect(setGoalSpy).not.toHaveBeenCalled();
    root.cleanup();
  });

  it('no KPI + high chat probability → may dispatch casual_chat', async () => {
    const root = createTestDataRoot('aut-chat-');
    patchAutonomyPolicy(root.dataRoot, { enabled: true });
    savePersonality(root.dataRoot, {
      version: 1,
      idleChatProbability: 1,
      updatedAt: new Date().toISOString(),
      updatedBy: 'system',
    });

    vi.spyOn(llmRaw, 'llmRawChatCompletion').mockResolvedValue({
      raw: { choices: [{ message: { content: '今天进展不错，有需要帮忙的吗？' } }] },
      status: 200,
    });

    const postMessage = vi.fn().mockResolvedValue(undefined);
    const registry = new InnerBrainRegistry(root.dataRoot);
    const kpiRegistry = new KpiRegistry(root.dataRoot);
    const identityRegistry = new IdentityRegistry(path.join(root.dataRoot, 'identities.json'));
    identityRegistry.upsert({ sid: 'human:u1', display_name: 'Alice', kind: 'human' });
    identityRegistry.upsert({ sid: 'agent-test', display_name: 'Bot', kind: 'agent' });

    const threadId = 'thread-im';
    const humanMsg = MessageRecordSchema.parse({
      schema: 'message.v1',
      message_id: 'msg:1',
      thread_id: threadId,
      sender_sid: 'human:u1',
      sent_at: '2026-05-29T10:00:00.000Z',
      parts: [{ type: 'text', text: '你觉得这个方向怎么样？' }],
    });

    const deps: AutonomyDispatchDeps = {
      dataRoot: root.dataRoot,
      agentSid: 'agent-test',
      workspaceId: 'default',
      defaultThreadId: threadId,
      registry,
      kpiRegistry,
      imClient: { postMessage } as never,
      toolCtx: {} as AutonomyDispatchDeps['toolCtx'],
      getLlmEnv: () => ({
        provider: 'kimi',
        apiKey: 'test',
        baseUrl: 'http://localhost',
        textModel: 'test-model',
      }),
      loadThreads: () => ({ threads: [], messages: { [threadId]: [humanMsg] } }),
      identityRegistry,
    };

    const result = await dispatchAutonomyTasks(deps, baseSnapshot(), idleVerdict());
    expect(result.dispatched).toBe(true);
    expect(result.taskType).toBe('casual_chat');
    expect(postMessage).toHaveBeenCalledOnce();
    root.cleanup();
  });
});

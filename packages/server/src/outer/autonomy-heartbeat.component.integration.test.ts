/**
 * ADL component: autonomy heartbeat pipeline
 * path: packages/server/src/outer/autonomy-pipeline.ts (+ outer-heartbeat.ts)
 *
 * 黑盒契约：probe → gates → dispatch；dispatch 成功时跳过 legacy LLM 心跳。
 */
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatAssetStore, IdentityRegistry, MessageRecordSchema } from '@utlra/chat-ir';
import { FilesystemRepositoryStore, FilesystemWorkspaceStore } from '../workspace-kit/index.js';
import { createTestDataRoot, type TestDataRoot } from '../testing/temp-data-root.js';
import { createNoopEngine } from '../testing/agent-stack-fixture.js';
import { InnerBrainRegistry } from './inner-brain-registry.js';
import { KpiRegistry } from './kpi-registry.js';
import { OuterHeartbeat, loadHeartbeatConfigFromEnv } from './outer-heartbeat.js';
import { runAutonomyPipeline } from './autonomy-pipeline.js';
import { patchAutonomyPolicy, saveAutonomyPolicy, defaultAutonomyPolicy } from './autonomy-policy-store.js';
import { savePersonality } from './personality.js';
import { beginLlmCall, resetLlmUsageTrackerForTests } from './llm-usage-tracker.js';
import { executeOuterTool, type OuterToolContext } from './outer-tools.js';
import * as llmRaw from '../llm/raw.js';

describe('component: autonomyHeartbeat', () => {
  let root: TestDataRoot;

  afterEach(() => {
    vi.restoreAllMocks();
    resetLlmUsageTrackerForTests();
    root?.cleanup();
  });

  function baseCtx(): OuterToolContext {
    return {
      threadId: '',
      agentSid: 'agent:test',
      workspaceId: 'default',
      imClient: {} as never,
      assetStore: new ChatAssetStore(path.join(root.dataRoot, 'uploads')),
      getEngine: () => createNoopEngine(),
      workspaceStore: new FilesystemWorkspaceStore(root.workspacesDir),
      repoStore: new FilesystemRepositoryStore(root.dataRoot),
      dataRoot: root.dataRoot,
    };
  }

  it('read/update_autonomy_policy + update_personality 工具主路径', async () => {
    root = createTestDataRoot('aut-hb-tools-');
    const ctx = baseCtx();

    const read0 = await executeOuterTool('read_autonomy_policy', '{}', ctx);
    expect(read0.output).toContain('hardGates:');
    expect(read0.output).toContain('personality.idleChatProbability');

    const upd = await executeOuterTool(
      'update_autonomy_policy',
      JSON.stringify({ max_running_inner_brains: '2', casual_chat_enabled: 'false' }),
      ctx,
    );
    expect(upd.output).toContain('自主策略已更新');

    const pers = await executeOuterTool(
      'update_personality',
      JSON.stringify({ idle_chat_probability: '0.35' }),
      ctx,
    );
    expect(pers.output).toContain('0.35');

    const read1 = await executeOuterTool('read_autonomy_policy', '{}', ctx);
    expect(read1.output).toContain('maxRunningInnerBrains: 2');
    expect(read1.output).toContain('casual_chat: enabled=false');
    expect(read1.output).toContain('personality.idleChatProbability: 0.35');
  });

  it('busy gate → runAutonomyPipeline 不 dispatch', async () => {
    root = createTestDataRoot('aut-hb-busy-');
    beginLlmCall();
    beginLlmCall();

    const registry = new InnerBrainRegistry(root.dataRoot);
    const kpiRegistry = new KpiRegistry(root.dataRoot);
    const policy = defaultAutonomyPolicy();
    policy.hardGates.maxLlmInFlight = 1;
    saveAutonomyPolicy(root.dataRoot, policy);

    const result = await runAutonomyPipeline({
      dataRoot: root.dataRoot,
      defaultThreadId: 'thread-1',
      registry,
      kpiRegistry,
      imClient: null,
      assetStore: new ChatAssetStore(path.join(root.dataRoot, 'uploads')),
      getEngine: () => createNoopEngine(),
      workspaceStore: new FilesystemWorkspaceStore(root.workspacesDir),
      repoStore: new FilesystemRepositoryStore(root.dataRoot),
      getLlmEnv: () => null,
    });

    expect(result.dispatch.dispatched).toBe(false);
    expect(result.skippedLegacyHeartbeat).toBe(false);
    expect(result.dispatch.reason).toMatch(/llm_in_flight/);
  });

  it('idle + 闲聊 dispatch → OuterHeartbeat 跳过 legacy LLM（无 tools 调用）', async () => {
    root = createTestDataRoot('aut-hb-skip-');
    patchAutonomyPolicy(root.dataRoot, {
      enabled: true,
      hardGates: { maxLlmInFlight: 5 },
      taskTypes: { casual_chat: { enabled: true, cooldownMs: 0, maxPerDay: 99 } },
    });
    savePersonality(root.dataRoot, {
      version: 1,
      idleChatProbability: 1,
      updatedAt: new Date().toISOString(),
      updatedBy: 'system',
    });

    const registry = new InnerBrainRegistry(root.dataRoot);
    const kpiRegistry = new KpiRegistry(root.dataRoot);
    const identityRegistry = new IdentityRegistry(path.join(root.dataRoot, 'identities.json'));
    identityRegistry.upsert({ sid: 'idp:human:alice', display_name: 'Alice', kind: 'human' });
    identityRegistry.upsert({ sid: 'agent:test', display_name: 'Test', kind: 'agent' });
    const postMessage = vi.fn().mockResolvedValue(undefined);
    const llmBodies: Record<string, unknown>[] = [];

    vi.spyOn(llmRaw, 'llmRawChatCompletion').mockImplementation(async (opts) => {
      llmBodies.push(opts.body);
      return {
        raw: { choices: [{ message: { content: '自主问候一句。' } }] },
        status: 200,
      };
    });

    const hb = new OuterHeartbeat({
      getEngine: () => createNoopEngine(),
      workspaceStore: new FilesystemWorkspaceStore(root.workspacesDir),
      repoStore: new FilesystemRepositoryStore(root.dataRoot),
      dataRoot: root.dataRoot,
      loadThreads: () => ({
        messages: {
          'thread-im': [
            MessageRecordSchema.parse({
              schema: 'message.v1',
              message_id: 'msg:hb-1',
              thread_id: 'thread-im',
              sender_sid: 'idp:human:alice',
              sent_at: '2026-06-07T10:00:00.000Z',
              parts: [{ type: 'text', text: '你好' }],
            }),
          ],
        },
      }),
      identityRegistry,
      getLlmEnv: () => ({
        provider: 'kimi',
        apiKey: 'test',
        baseUrl: 'http://localhost',
        textModel: 'test-model',
        visionModel: 'test-model',
        maxTokensText: 256,
        maxTokensMultimodal: 256,
        thinking: 'disabled',
      }),
      imClient: { postMessage } as never,
      assetStore: new ChatAssetStore(path.join(root.dataRoot, 'uploads')),
      innerBrainRegistry: registry,
      kpiRegistry,
      config: {
        ...loadHeartbeatConfigFromEnv({ UTLRA_OUTER_HEARTBEAT_ENABLED: 'true' }),
        enabled: true,
        intervalMs: 60_000,
        defaultThreadId: 'thread-im',
        agentName: 'Test',
        agentSid: 'agent:test',
      },
    });

    await hb.triggerNow();

    expect(postMessage).toHaveBeenCalledOnce();
    expect(llmBodies.length).toBeGreaterThanOrEqual(1);
    expect(llmBodies[0]?.['tools']).toBeUndefined();
  });

  it('KPI 在途 AWAITING burst → autonomy hold + 跳过 legacy LLM', async () => {
    root = createTestDataRoot('aut-hb-kpi-sprint-');
    patchAutonomyPolicy(root.dataRoot, {
      enabled: true,
      hardGates: { maxLlmInFlight: 5 },
      taskTypes: { kpi_inner_goal: { enabled: true } },
    });

    const registry = new InnerBrainRegistry(root.dataRoot);
    const kpiRegistry = new KpiRegistry(root.dataRoot);
    const kpiId = kpiRegistry.create({
      description: 'sprint kpi',
      createdBy: 'idp:agent:test',
    }).kpiId;
    kpiRegistry.attachBurst(kpiId, 'ib-await');
    registry.register({
      instanceId: 'ib-await',
      workspaceId: 'task-ib-await',
      workDir: `${root.workspacesDir}/task-ib-await`,
      goal: 'in flight',
      originUser: 'idp:agent:test',
      startedAt: new Date().toISOString(),
      status: 'AWAITING',
      kpiId,
    });

    const llmBodies: Record<string, unknown>[] = [];
    vi.spyOn(llmRaw, 'llmRawChatCompletion').mockImplementation(async (opts) => {
      llmBodies.push(opts.body);
      return { raw: { choices: [{ message: { content: '不应执行' } }] }, status: 200 };
    });

    const pipeline = await runAutonomyPipeline({
      dataRoot: root.dataRoot,
      defaultThreadId: 'thread-1',
      registry,
      kpiRegistry,
      imClient: null,
      assetStore: new ChatAssetStore(path.join(root.dataRoot, 'uploads')),
      getEngine: () => createNoopEngine(),
      workspaceStore: new FilesystemWorkspaceStore(root.workspacesDir),
      repoStore: new FilesystemRepositoryStore(root.dataRoot),
      getLlmEnv: () => ({
        provider: 'kimi',
        apiKey: 'test',
        baseUrl: 'http://localhost',
        textModel: 'test-model',
        visionModel: 'test-model',
        maxTokensText: 256,
        maxTokensMultimodal: 256,
        thinking: 'disabled',
      }),
    });

    expect(pipeline.dispatch.dispatched).toBe(false);
    expect(pipeline.dispatch.reason).toBe('kpi_sprint_in_progress');
    expect(pipeline.skippedLegacyHeartbeat).toBe(true);
    // 战略层常开：idle 时会先跑一次 strategy 规划（plan LLM 调用），但 dispatch 仍按 in-flight burst hold，
    // 且不会触发 legacy heartbeat（legacy KPI 心跳会带 tools；strategy 规划是纯 JSON 请求，无 tools）。
    expect(llmBodies.every((b) => b['tools'] === undefined)).toBe(true);
  });
});

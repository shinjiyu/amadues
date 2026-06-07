import { describe, expect, it } from 'vitest';
import { executeOuterTool, type OuterToolContext } from './outer-tools.js';

function minimalCtx(overrides: Partial<OuterToolContext> = {}): OuterToolContext {
  return {
    threadId: 't1',
    agentSid: 'agent:test',
    workspaceId: 'default',
    imClient: { postMessage: async () => {} } as never,
    assetStore: {} as never,
    getEngine: () => ({ setGoal() {} }) as never,
    workspaceStore: { ensureWorkspace() {} } as never,
    repoStore: {} as never,
    dataRoot: '/tmp',
    ...overrides,
  };
}

describe('set_goal KPI 路径封禁', () => {
  it('外脑 LLM 传 kpi_id → 拒绝', async () => {
    const r = await executeOuterTool(
      'set_goal',
      JSON.stringify({ goal: 'test', kpi_id: 'kpi-abc' }),
      minimalCtx({
        innerBrainRegistry: { list: () => [], generateInstanceId: () => 'ib-x' } as never,
        kpiRegistry: { get: () => ({ kpiId: 'kpi-abc', status: 'active' }) } as never,
      }),
    );
    expect(r.output).toContain('advance_kpi');
  });

});

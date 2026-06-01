import { afterEach, describe, expect, it } from 'vitest';

import { createTestDataRoot } from '../testing/temp-data-root.js';
import { appendLlmUsageJournalEntry } from '../outer/llm-usage-journal.js';
import {
  configureLlmUsageTracker,
  resetLlmUsageTrackerForTests,
} from '../outer/llm-usage-tracker.js';

describe('llmUsageJournal component', () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    resetLlmUsageTrackerForTests();
    cleanup?.();
    cleanup = null;
  });

  it('GET /api/usage/summary returns aggregated journal + runtime', async () => {
    const prevSkip = process.env['UTLRA_SKIP_AGENT_BOOTSTRAP'];
    const prevDataRoot = process.env['UTLRA_DATA_ROOT'];
    const prevAgent = process.env['UTLRA_AGENT_NAME'];

    const tmp = createTestDataRoot('llm-usage-api-');
    cleanup = tmp.cleanup;
    process.env['UTLRA_SKIP_AGENT_BOOTSTRAP'] = '1';
    process.env['UTLRA_DATA_ROOT'] = tmp.dataRoot;
    process.env['UTLRA_AGENT_NAME'] = 'test-agent';

    configureLlmUsageTracker({ dataRoot: tmp.dataRoot, agentId: 'test-agent' });
    appendLlmUsageJournalEntry(tmp.dataRoot, {
      at: new Date().toISOString(),
      source: 'outer_conversation',
      model: 'glm-5.1',
      agentId: 'test-agent',
      promptTokens: 1000,
      completionTokens: 200,
      reasoningTokens: 0,
      totalTokens: 1200,
      ok: true,
    });

    const { app } = await import('../index.js');
    const res = await app.request('/api/usage/summary?hours=24');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agentId: string;
      totals: { calls: number; totalTokens: number };
      byModel: Record<string, { calls: number }>;
    };
    expect(body.agentId).toBe('test-agent');
    expect(body.totals.calls).toBe(1);
    expect(body.totals.totalTokens).toBe(1200);
    expect(body.byModel['glm-5.1']?.calls).toBe(1);

    if (prevSkip === undefined) delete process.env['UTLRA_SKIP_AGENT_BOOTSTRAP'];
    else process.env['UTLRA_SKIP_AGENT_BOOTSTRAP'] = prevSkip;
    if (prevDataRoot === undefined) delete process.env['UTLRA_DATA_ROOT'];
    else process.env['UTLRA_DATA_ROOT'] = prevDataRoot;
    if (prevAgent === undefined) delete process.env['UTLRA_AGENT_NAME'];
    else process.env['UTLRA_AGENT_NAME'] = prevAgent;
  });
});

import { afterEach, describe, expect, it } from 'vitest';

import { createTestDataRoot } from '../testing/temp-data-root.js';
import {
  appendLlmUsageJournalEntry,
  buildLlmUsageSummary,
  readLlmUsageJournalEntries,
} from './llm-usage-journal.js';
import type { LlmUsageJournalEntry } from './llm-usage-types.js';
import { parseLlmUsageFromResponse } from './llm-usage-types.js';
import {
  configureLlmUsageTracker,
  getLlmUsageSnapshot,
  recordLlmUsageFromResponse,
  resetLlmUsageTrackerForTests,
} from './llm-usage-tracker.js';

function sampleEntry(overrides: Partial<LlmUsageJournalEntry> = {}): LlmUsageJournalEntry {
  return {
    at: new Date().toISOString(),
    source: 'outer_conversation',
    model: 'glm-5.1',
    agentId: 'gin',
    promptTokens: 100,
    completionTokens: 50,
    reasoningTokens: 10,
    totalTokens: 150,
    ok: true,
    ...overrides,
  };
}

describe('parseLlmUsageFromResponse', () => {
  it('parses prompt/completion and reasoning_tokens', () => {
    const parsed = parseLlmUsageFromResponse({
      usage: {
        prompt_tokens: 12,
        completion_tokens: 8,
        completion_tokens_details: { reasoning_tokens: 5 },
      },
    });
    expect(parsed).toEqual({
      promptTokens: 12,
      completionTokens: 8,
      reasoningTokens: 5,
      totalTokens: 20,
    });
  });
});

describe('llm-usage-journal', () => {
  let dataRoot = '';
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    dataRoot = '';
  });

  it('appends and reads entries', () => {
    const tmp = createTestDataRoot('llm-usage-journal-');
    dataRoot = tmp.dataRoot;
    cleanup = tmp.cleanup;
    appendLlmUsageJournalEntry(dataRoot, sampleEntry({ model: 'a' }));
    appendLlmUsageJournalEntry(dataRoot, sampleEntry({ model: 'b', totalTokens: 200 }));

    const all = readLlmUsageJournalEntries(dataRoot);
    expect(all).toHaveLength(2);
    expect(all[1]?.model).toBe('b');
  });

  it('builds summary by source and model', () => {
    const tmp = createTestDataRoot('llm-usage-summary-');
    dataRoot = tmp.dataRoot;
    cleanup = tmp.cleanup;
    appendLlmUsageJournalEntry(dataRoot, sampleEntry({ source: 'outer_conversation', model: 'glm-5.1' }));
    appendLlmUsageJournalEntry(
      dataRoot,
      sampleEntry({ source: 'autonomy', model: 'deepseek-v4', totalTokens: 80, promptTokens: 50, completionTokens: 30 }),
    );

    const summary = buildLlmUsageSummary(dataRoot, 'gin', 24, {
      inFlight: 1,
      tokensLast1h: { prompt: 10, completion: 5, total: 15 },
      callsLast1h: 2,
    });

    expect(summary.totals.calls).toBe(2);
    expect(summary.totals.totalTokens).toBe(230);
    expect(summary.bySource['outer_conversation']?.calls).toBe(1);
    expect(summary.bySource['autonomy']?.totalTokens).toBe(80);
    expect(summary.byModel['glm-5.1']?.calls).toBe(1);
    expect(summary.runtime.inFlight).toBe(1);
    expect(summary.recent.length).toBeGreaterThanOrEqual(2);
  });
});

describe('llm-usage-tracker', () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    resetLlmUsageTrackerForTests();
    cleanup?.();
    cleanup = null;
  });

  it('records in-memory snapshot and persists journal', () => {
    const tmp = createTestDataRoot('llm-usage-tracker-');
    cleanup = tmp.cleanup;
    configureLlmUsageTracker({ dataRoot: tmp.dataRoot, agentId: 'gin' });

    recordLlmUsageFromResponse(
      { usage: { prompt_tokens: 20, completion_tokens: 10 } },
      { source: 'probe', model: 'test-model' },
    );

    const snap = getLlmUsageSnapshot();
    expect(snap.tokensLast1h.total).toBe(30);
    expect(snap.callsLast1h).toBe(1);

    const entries = readLlmUsageJournalEntries(tmp.dataRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe('probe');
    expect(entries[0]?.model).toBe('test-model');
  });
});

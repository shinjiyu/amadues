import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFERRED_CAP } from './constants.js';
import { createInitialState, loadState, saveState, subjectDir } from './state-store.js';
import { runSubjectThink } from './think.js';
import { createTestDataRoot } from '../../testing/temp-data-root.js';
import type { DeferredItem } from './types.js';

function openItem(index: number, nowMs: number): DeferredItem {
  return {
    id: `def-${index}`,
    source: 'human:alice',
    kind: 'message',
    threadId: 'thread:1',
    raw: `old-${index}`,
    parsed: {
      source: 'human:alice',
      kind: 'message',
      intent_category: 'statement',
      entities: [],
      sentiment: 'neutral',
    },
    createdAt: new Date(nowMs - index).toISOString(),
    revisitAt: new Date(nowMs + 60_000).toISOString(),
    statusAckAt: null,
    status: 'open',
  };
}

describe('subjectStateStore', () => {
  it('leaves state.json parseable when a temp file is left behind', () => {
    const root = createTestDataRoot('subject-store-');
    const now = Date.parse('2026-10-12T00:00:00.000Z');
    const state = createInitialState(root.dataRoot, now);
    saveState(root.dataRoot, state);
    const file = path.join(subjectDir(root.dataRoot), 'state.json');
    fs.writeFileSync(`${file}.999.tmp`, '{not json');
    const loaded = loadState(root.dataRoot, now);
    expect(loaded.identity).toBe(state.identity);
    expect(loaded.version).toBe(1);
    root.cleanup();
  });

  it('drops the oldest open defer when the cap is exceeded', async () => {
    const root = createTestDataRoot('subject-store-cap-');
    const now = Date.parse('2026-10-12T00:00:00.000Z');
    const state = createInitialState(root.dataRoot, now);
    state.deferred = Array.from({ length: DEFERRED_CAP }, (_, index) => openItem(index, now));
    saveState(root.dataRoot, state);
    await runSubjectThink({
      dataRoot: root.dataRoot,
      nowMs: now,
      trigger: 'inbound',
      agentSid: 'agent:test',
      signals: [{
        source: 'human:alice',
        kind: 'message',
        raw: '新的一件',
        threadId: 'thread:1',
        messageId: 'm-new',
      }],
      callLlm: async (_system, user) => user.includes('[TASK:EVALUATE]')
        ? '{"scores":[{"action":"defer","score":1}]}'
        : '{"candidates":[{"action":"defer","args":{}}]}',
    });
    const loaded = loadState(root.dataRoot, now);
    const open = loaded.deferred.filter((item) => item.status === 'open');
    expect(open.length).toBeLessThanOrEqual(DEFERRED_CAP);
    expect(loaded.deferred.some((item) => item.id === `def-${DEFERRED_CAP - 1}` && item.status === 'dropped')).toBe(true);
    expect(open.some((item) => item.raw === '新的一件')).toBe(true);
    root.cleanup();
  });
});

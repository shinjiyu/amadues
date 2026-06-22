import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDesignerTools } from './designer-tools.js';
import { createLocalNodeStore } from './local-node-store.js';
import { createMemoryStore } from './memory-store.js';
import {
  PLAN_REFERENCES_MEMORY_KEY,
  type PlanReferenceHit,
  type PlanReferencePort,
} from './plan-reference-port.js';

describe('search_task_plans designer tool', () => {
  let root = '';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-plans-'));
  });

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('is not registered without planReference deps', () => {
    const { registry } = createDesignerTools({
      store: createLocalNodeStore(root),
      memory: createMemoryStore(root),
      workDir: root,
      burstId: 'b1',
    });
    expect(registry.get('search_task_plans')).toBeUndefined();
  });

  it('stores hits in plan_references without touching fact_records', async () => {
    const memory = createMemoryStore(root);
    memory.recordFact({ content: '[事实] 已验证端点', topic: 'api', source: { at: new Date().toISOString(), via: 'record_fact' } });
    const beforeFacts = memory.read().fact_records?.length ?? 0;

    const port: PlanReferencePort = {
      async search() {
        return [
          { source: 'archive', title: 'hist', snippet: '某 API 曾失败（未验证）' },
        ] satisfies PlanReferenceHit[];
      },
    };

    const { registry } = createDesignerTools({
      store: createLocalNodeStore(root),
      memory,
      workDir: root,
      burstId: 'b1',
      planReference: { port, kpiId: 'kpi-1' },
    });

    const tool = registry.get('search_task_plans')!;
    const out = await tool.call({ query: 'API 方案' });
    expect(out.ok).toBe(true);
    expect(out.output).toContain('未验证');
    expect(out.output).toContain('某 API 曾失败');

    const mem = memory.read();
    const refs = mem[PLAN_REFERENCES_MEMORY_KEY] as Array<{ title: string }>;
    expect(refs).toHaveLength(1);
    expect(refs[0]?.title).toBe('hist');
    expect(mem.fact_records?.length ?? 0).toBe(beforeFacts);
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildDyflowInspectorPayload, isDyflowWorkDir } from './dyflow-inspector.js';

describe('dyflow-inspector', () => {
  let root: string;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('detects dyflow workDir', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dyflow-insp-'));
    const brain = path.join(root, '.brain');
    fs.mkdirSync(brain, { recursive: true });
    expect(isDyflowWorkDir(root)).toBe(false);
    fs.writeFileSync(
      path.join(brain, 'dyflow-state.json'),
      JSON.stringify({ mode: 'RUN', burstId: 'b1' }),
    );
    expect(isDyflowWorkDir(root)).toBe(true);
  });

  it('builds payload from disk', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dyflow-insp-'));
    const brain = path.join(root, '.brain');
    fs.mkdirSync(path.join(brain, 'local_nodes', 'preset'), { recursive: true });
    fs.writeFileSync(path.join(brain, 'dyflow-state.json'), JSON.stringify({ mode: 'DESIGN', burstId: 'b2' }));
    fs.writeFileSync(
      path.join(brain, 'local_dag.json'),
      JSON.stringify({
        nodes: [{ id: 'n1', ref: 'preset/base', instruction: 'do x' }],
      }),
    );
    fs.writeFileSync(
      path.join(brain, 'memory.json'),
      JSON.stringify({
        facts: ['a'],
        constraints: [],
        node_results: { n0: { ok: true, ref: 'preset/base' } },
        last_failure: {
          nodeInstId: 'n9',
          localRef: 'preset/base',
          summary: 'proxy blocked',
          attempted: [],
          confidence: 'low',
          transient: true,
          at: new Date().toISOString(),
        },
      }),
    );

    const p = buildDyflowInspectorPayload(root);
    expect(p.engine).toBe('dyflow');
    expect(p.state?.mode).toBe('DESIGN');
    expect(p.dag?.nodeCount).toBe(1);
    expect(p.memory?.lastFailure?.summary).toContain('proxy');
    expect(p.memory?.nodeResults).toHaveLength(1);
  });
});

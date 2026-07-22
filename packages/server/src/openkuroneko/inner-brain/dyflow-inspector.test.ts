import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildDyflowInspectorPayload,
  isDyflowWorkDir,
  summarizeDyflowForList,
} from './dyflow-inspector.js';

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

  describe('summarizeDyflowForList', () => {
    it('returns nulls for a non-dyflow workDir', () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'dyflow-insp-'));
      expect(summarizeDyflowForList(root)).toEqual({
        dyflow_mode: null,
        dyflow_dag_nodes: null,
        dyflow_failure: null,
      });
    });

    it('reads mode/dag/failure WITHOUT requiring local_nodes scan', () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'dyflow-insp-'));
      const brain = path.join(root, '.brain');
      fs.mkdirSync(brain, { recursive: true }); // 注意：故意不建 local_nodes/
      fs.writeFileSync(path.join(brain, 'dyflow-state.json'), JSON.stringify({ mode: 'RUN' }));
      fs.writeFileSync(
        path.join(brain, 'local_dag.json'),
        JSON.stringify({ nodes: [{ id: 'n1', ref: 'preset/base' }, { id: 'n2', ref: 'local/x' }] }),
      );
      fs.writeFileSync(
        path.join(brain, 'memory.json'),
        JSON.stringify({ last_failure: { summary: 'x'.repeat(200), transient: false } }),
      );

      const s = summarizeDyflowForList(root);
      expect(s.dyflow_mode).toBe('RUN');
      expect(s.dyflow_dag_nodes).toBe(2);
      expect(s.dyflow_failure).toHaveLength(80); // 截断到 80 字符
    });

    it('skips oversized memory.json instead of parsing it for list', () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'dyflow-insp-'));
      const brain = path.join(root, '.brain');
      fs.mkdirSync(brain, { recursive: true });
      fs.writeFileSync(path.join(brain, 'dyflow-state.json'), JSON.stringify({ mode: 'RUN' }));
      fs.writeFileSync(path.join(brain, 'local_dag.json'), JSON.stringify({ nodes: [] }));
      fs.writeFileSync(
        path.join(brain, 'memory.json'),
        JSON.stringify({
          facts: Array.from({ length: 2000 }, (_, i) => `fact-${i}-${'x'.repeat(40)}`),
          last_failure: { summary: 'should-not-load' },
        }),
      );
      expect(fs.statSync(path.join(brain, 'memory.json')).size).toBeGreaterThan(64 * 1024);

      const s = summarizeDyflowForList(root);
      expect(s.dyflow_mode).toBe('RUN');
      expect(s.dyflow_failure).toBeNull();
    });
  });
});

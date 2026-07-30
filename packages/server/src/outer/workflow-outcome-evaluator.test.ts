import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { evaluateWorkflowOutcome } from './workflow-outcome-evaluator.js';

describe('evaluateWorkflowOutcome', () => {
  let tmp = '';

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('missing workflow_run → needsEvolution', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-out-'));
    const ev = evaluateWorkflowOutcome(tmp);
    expect(ev.needsEvolution).toBe(true);
    expect(ev.reasons).toContain('missing_workflow_run');
  });

  it('ok=false → needsEvolution', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-out-'));
    fs.mkdirSync(path.join(tmp, '.run'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.run', 'workflow_run.json'),
      JSON.stringify({
        workflowId: 'ew-x',
        version: '2',
        ok: false,
        steps: [{ stepId: 'collect', ok: false, detail: 'exit 2' }],
      }),
      'utf8',
    );
    const ev = evaluateWorkflowOutcome(tmp);
    expect(ev.okMechanical).toBe(false);
    expect(ev.needsEvolution).toBe(true);
    expect(ev.signature).toMatch(/step_failed|exit/);
  });

  it('ok=true + summary files → quality ok', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-out-'));
    fs.mkdirSync(path.join(tmp, '.run'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'workspace'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.run', 'workflow_run.json'),
      JSON.stringify({ workflowId: 'ew-x', version: '3', ok: true, steps: [{ ok: true }] }),
      'utf8',
    );
    fs.writeFileSync(path.join(tmp, 'workspace', 'tweets_summary.md'), '# ok\n', 'utf8');
    fs.writeFileSync(path.join(tmp, 'workspace', 'tweets_summary.json'), '[]', 'utf8');
    const ev = evaluateWorkflowOutcome(tmp);
    expect(ev.okMechanical).toBe(true);
    expect(ev.okQuality).toBe(true);
    expect(ev.needsEvolution).toBe(false);
    expect(ev.deliverableCount).toBeGreaterThanOrEqual(1);
  });

  it('ok=true without deliverables → needsEvolution', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-out-'));
    fs.mkdirSync(path.join(tmp, '.run'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.run', 'workflow_run.json'),
      JSON.stringify({ workflowId: 'ew-x', version: '1', ok: true, steps: [{ ok: true }] }),
      'utf8',
    );
    const ev = evaluateWorkflowOutcome(tmp);
    expect(ev.needsEvolution).toBe(true);
    expect(ev.reasons).toContain('no_registered_deliverables');
  });
});

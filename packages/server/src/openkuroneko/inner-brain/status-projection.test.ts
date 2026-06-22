import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import {
  mapDyflowModeToInnerPhase,
  projectDyflowStatus,
  resolveOuterBrainPhase,
  touchWorkerLiveness,
} from './status-projection.js';

describe('status-projection', () => {
  let root = '';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-proj-'));
    fs.mkdirSync(path.join(root, '.brain'), { recursive: true });
    fs.mkdirSync(path.join(root, '.run'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.brain', 'dyflow-state.json'),
      JSON.stringify({ mode: 'DESIGN', burstId: 'b1' }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(root, '.run', 'status.json'),
      JSON.stringify({
        schema: 'inner-status.v1',
        workspaceId: 'ws1',
        phase: 'planning',
        goalSummary: 'old',
        tickCount: 0,
        lastAction: 'goal_set',
        lastError: null,
        updatedAt: '2020-01-01T00:00:00.000Z',
        deliverables: [],
      }),
      'utf8',
    );
  });

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('maps DESIGN/RUN to executing not planning', () => {
    expect(mapDyflowModeToInnerPhase('DESIGN')).toBe('executing');
    expect(mapDyflowModeToInnerPhase('RUN')).toBe('executing');
    expect(mapDyflowModeToInnerPhase('AWAITING')).toBe('paused');
  });

  it('projectDyflowStatus overwrites stale planning status', () => {
    const out = projectDyflowStatus({
      workspaceId: 'ws1',
      workDir: root,
      tickCount: 1,
      hadWork: true,
      dyflowMode: 'DESIGN',
      note: 'tick_start',
    });
    expect(out?.phase).toBe('executing');
    expect(out?.tickCount).toBe(1);
    expect(out?.lastAction).toContain('dyflow:DESIGN');

    const disk = JSON.parse(
      fs.readFileSync(path.join(root, '.run', 'status.json'), 'utf8'),
    ) as { phase: string };
    expect(disk.phase).toBe('executing');
  });

  it('resolveOuterBrainPhase exposes dyflow mode to outer brain', () => {
    const r = resolveOuterBrainPhase(root);
    expect(r.engine).toBe('dyflow');
    expect(r.dyflow_mode).toBe('DESIGN');
    expect(r.phase).toBe('dyflow:DESIGN');
  });

  it('touchWorkerLiveness refreshes lastTickAt during long tick', () => {
    touchWorkerLiveness(root, { ticks: 0, lastTickAt: '2026-06-08T12:00:00.000Z' });
    const w = JSON.parse(
      fs.readFileSync(path.join(root, '.run', 'inner-worker-status.json'), 'utf8'),
    ) as { lastTickAt: string; phase: string };
    expect(w.lastTickAt).toBe('2026-06-08T12:00:00.000Z');
    expect(w.phase).toBe('running');
  });
});

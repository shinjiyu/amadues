import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';

import { addPending } from '../openkuroneko/pendings/index.js';
import {
  POST_COMPLETE_REASON,
  buildBrainAsyncSnapshot,
  formatBrainAsyncSnapshotForLlm,
  isBrainAwaitingAsync,
} from './brain-async-snapshot.js';

describe('brain-async-snapshot', () => {
  let tmp = '';

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  function mkWorkDir(): string {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-async-'));
    fs.mkdirSync(path.join(tmp, '.brain'), { recursive: true });
    return tmp;
  }

  it('timer pending → is_async_waiting, next_wake_at set', () => {
    const workDir = mkWorkDir();
    const brainDir = path.join(workDir, '.brain');
    addPending(brainDir, {
      kind: 'timer',
      spec: { execute_at: '2026-05-17T10:00:00.000Z' },
      source: 'tool:wait_timer(test)',
    });
    fs.writeFileSync(
      path.join(brainDir, 'controller-state.json'),
      JSON.stringify({ mode: 'AWAITING', awaitingReason: '等定时' }),
      'utf8',
    );
    const snap = buildBrainAsyncSnapshot(workDir);
    expect(snap.is_async_waiting).toBe(true);
    expect(snap.is_post_complete).toBe(false);
    expect(snap.next_wake_at).toBe('2026-05-17T10:00:00.000Z');
    expect(isBrainAwaitingAsync(workDir)).toBe(true);
  });

  it('all-complete ask_user only → post_complete, not async waiting', () => {
    const workDir = mkWorkDir();
    const brainDir = path.join(workDir, '.brain');
    addPending(brainDir, {
      kind: 'ask_user',
      spec: { prompt: POST_COMPLETE_REASON },
      source: 'all-complete',
    });
    fs.writeFileSync(
      path.join(brainDir, 'controller-state.json'),
      JSON.stringify({ mode: 'AWAITING', awaitingReason: POST_COMPLETE_REASON }),
      'utf8',
    );
    const snap = buildBrainAsyncSnapshot(workDir);
    expect(snap.is_post_complete).toBe(true);
    expect(snap.is_async_waiting).toBe(false);
    expect(isBrainAwaitingAsync(workDir)).toBe(false);
  });

  it('dyflow AWAITING without controller-state → is_async_waiting', () => {
    const workDir = mkWorkDir();
    const brainDir = path.join(workDir, '.brain');
    fs.writeFileSync(
      path.join(brainDir, 'dyflow-state.json'),
      JSON.stringify({ mode: 'AWAITING', burstId: 'b1', reason: 'timer pending', updatedAt: new Date().toISOString() }),
      'utf8',
    );
    addPending(brainDir, {
      kind: 'timer',
      spec: { execute_at: '2026-05-17T12:00:00.000Z' },
      source: 'tool:wait_timer(test)',
    });
    const snap = buildBrainAsyncSnapshot(workDir);
    expect(snap.controller.mode).toBe('AWAITING');
    expect(snap.is_async_waiting).toBe(true);
    expect(isBrainAwaitingAsync(workDir)).toBe(true);
  });

  it('dyflow DESIGN (no legacy planning) → not async waiting without pendings', () => {
    const workDir = mkWorkDir();
    const brainDir = path.join(workDir, '.brain');
    fs.writeFileSync(
      path.join(brainDir, 'dyflow-state.json'),
      JSON.stringify({ mode: 'DESIGN', burstId: 'b1', designStreak: 0, updatedAt: new Date().toISOString() }),
      'utf8',
    );
    const snap = buildBrainAsyncSnapshot(workDir);
    expect(snap.controller.mode).toBe('DESIGN');
    expect(snap.is_async_waiting).toBe(false);
    expect(isBrainAwaitingAsync(workDir)).toBe(false);
  });

  it('formatBrainAsyncSnapshotForLlm converts ISO times for LLM output', () => {
    const workDir = mkWorkDir();
    const brainDir = path.join(workDir, '.brain');
    addPending(brainDir, {
      kind: 'timer',
      spec: { execute_at: '2026-05-17T10:00:00.000Z' },
      source: 'tool:wait_timer(test)',
    });
    const raw = buildBrainAsyncSnapshot(workDir);
    const formatted = formatBrainAsyncSnapshotForLlm(raw);
    expect(formatted.next_wake_at).toContain('18:00');
    expect(formatted.active_pendings[0]?.execute_at).toContain('18:00');
    expect(raw.next_wake_at).toBe('2026-05-17T10:00:00.000Z');
  });
});

describe('OUTER_ASYNC_ORCHESTRATION_GUIDE', () => {
  it('teaches dual-track realtime + calendar and forbids denying cron', async () => {
    const { OUTER_ASYNC_ORCHESTRATION_GUIDE } = await import('./brain-async-snapshot.js');
    expect(OUTER_ASYNC_ORCHESTRATION_GUIDE).toMatch(/双轨/);
    expect(OUTER_ASYNC_ORCHESTRATION_GUIDE).toMatch(/employeeCalendar/);
    expect(OUTER_ASYNC_ORCHESTRATION_GUIDE).toMatch(/list_calendar/);
    expect(OUTER_ASYNC_ORCHESTRATION_GUIDE).toMatch(/schedule_commitment/);
    expect(OUTER_ASYNC_ORCHESTRATION_GUIDE).toMatch(/禁止.*没有/);
    expect(OUTER_ASYNC_ORCHESTRATION_GUIDE).not.toMatch(/KPI 推进器/);
  });
});

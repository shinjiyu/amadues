import { describe, expect, it } from 'vitest';

import { HOUR_MS } from './constants.js';
import { accrue, heartbeatShouldThink } from './drive.js';
import { createInitialState, saveState } from './state-store.js';
import { subjectHeartbeatWouldThink } from './think.js';
import { createTestDataRoot } from '../../testing/temp-data-root.js';
import type { SubjectState } from './types.js';

function withDrives(state: SubjectState, drives: SubjectState['drives'], nowMs: number): SubjectState {
  return {
    ...state,
    drives,
    lastAccruedAt: new Date(nowMs).toISOString(),
  };
}

describe('subjectDrive', () => {
  it('accrues curiosity by 0.10 per hour and treats 0.60 as not over threshold', () => {
    const root = createTestDataRoot('subject-drive-');
    const now = Date.parse('2026-10-12T00:00:00.000Z');
    const start = withDrives(createInitialState(root.dataRoot, now), {
      curiosity: 0.3,
      social: 0.3,
      completion: 0.3,
    }, now);
    const threeHours = accrue(start, now + 3 * HOUR_MS);
    expect(threeHours.drives.curiosity).toBeCloseTo(0.6);
    expect(heartbeatShouldThink({
      state: threeHours,
      nowMs: now + 3 * HOUR_MS,
      dueDefer: false,
      inboxNonEmpty: false,
    })).toBe(false);
    const fourHours = accrue(start, now + 4 * HOUR_MS);
    expect(fourHours.drives.curiosity).toBeCloseTo(0.7);
    root.cleanup();
  });

  it('clamps a week offline to 1', () => {
    const root = createTestDataRoot('subject-drive-gap-');
    const now = Date.parse('2026-10-12T00:00:00.000Z');
    const start = createInitialState(root.dataRoot, now);
    const later = accrue(start, now + 7 * 24 * HOUR_MS);
    expect(later.drives.curiosity).toBe(1);
    expect(later.drives.social).toBe(1);
    expect(later.drives.completion).toBe(1);
    root.cleanup();
  });

  it('does not think below threshold when nothing is waiting', () => {
    const root = createTestDataRoot('subject-drive-low-');
    const now = Date.parse('2026-10-12T00:00:00.000Z');
    const state = withDrives(createInitialState(root.dataRoot, now), {
      curiosity: 0.2,
      social: 0.2,
      completion: 0.2,
    }, now);
    expect(heartbeatShouldThink({
      state,
      nowMs: now,
      dueDefer: false,
      inboxNonEmpty: false,
    })).toBe(false);
    root.cleanup();
  });

  it('blocks a drive-only tail during cooldown and still allows a non-empty inbox', () => {
    const root = createTestDataRoot('subject-drive-cool-');
    const now = Date.parse('2026-10-12T05:00:00.000Z');
    const state: SubjectState = {
      ...withDrives(createInitialState(root.dataRoot, now), {
        curiosity: 0.9,
        social: 0.2,
        completion: 0.2,
      }, now),
      lastDriveOnlyThinkAt: new Date(now - HOUR_MS).toISOString(),
    };
    expect(heartbeatShouldThink({
      state,
      nowMs: now,
      dueDefer: false,
      inboxNonEmpty: false,
    })).toBe(false);
    expect(heartbeatShouldThink({
      state,
      nowMs: now,
      dueDefer: false,
      inboxNonEmpty: true,
    })).toBe(true);
    saveState(root.dataRoot, state);
    expect(subjectHeartbeatWouldThink(root.dataRoot, now)).toBe(false);
    root.cleanup();
  });
});

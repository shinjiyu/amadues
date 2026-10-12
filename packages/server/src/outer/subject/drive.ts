import { HOUR_MS, THINK_THRESHOLD } from './constants.js';
import { clamp01 } from './text.js';
import type { SubjectDrives, SubjectState } from './types.js';

/** Rates in the ADL are decimal hundredths. Round so 0.30 + 3 * 0.10 stays 0.60. */
function roundDrive(value: number): number {
  return Math.round(clamp01(value) * 1_000_000) / 1_000_000;
}

export function accrue(state: SubjectState, nowMs: number): SubjectState {
  const last = Date.parse(state.lastAccruedAt);
  const hours = Math.max(0, nowMs - (Number.isFinite(last) ? last : nowMs)) / HOUR_MS;
  const nextDrives = { ...state.drives };
  (Object.keys(nextDrives) as Array<keyof SubjectDrives>).forEach((key) => {
    const rate = state.accrualPerHour[key] ?? 0;
    nextDrives[key] = roundDrive(nextDrives[key] + rate * hours);
  });
  return {
    ...state,
    drives: nextDrives,
    lastAccruedAt: new Date(nowMs).toISOString(),
  };
}

export function maxDrive(drives: SubjectDrives): number {
  return Math.max(drives.curiosity, drives.social, drives.completion);
}

export function driveOnlyCooldownElapsed(state: SubjectState, nowMs: number): boolean {
  if (!state.lastDriveOnlyThinkAt) return true;
  const last = Date.parse(state.lastDriveOnlyThinkAt);
  if (!Number.isFinite(last)) return true;
  return nowMs >= last + state.driveThinkCooldownMs;
}

/** Heartbeat tail gate. Inbound SPEAK does not use this. */
export function heartbeatShouldThink(input: {
  state: SubjectState;
  nowMs: number;
  dueDefer: boolean;
  inboxNonEmpty: boolean;
}): boolean {
  if (input.dueDefer || input.inboxNonEmpty) return true;
  return maxDrive(input.state.drives) > (input.state.thinkThreshold ?? THINK_THRESHOLD)
    && driveOnlyCooldownElapsed(input.state, input.nowMs);
}

export function decayDrive(state: SubjectState, drive: keyof SubjectDrives | null): SubjectState {
  if (!drive) return state;
  return {
    ...state,
    drives: {
      ...state.drives,
      [drive]: roundDrive(state.drives[drive] - state.decayOnAct),
    },
  };
}

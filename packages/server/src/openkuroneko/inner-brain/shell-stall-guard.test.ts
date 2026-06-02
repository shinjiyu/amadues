import { describe, expect, it } from 'vitest';

import { createShellStallGuard, normalizeShellCommand } from './shell-stall-guard.js';

describe('shell-stall-guard', () => {
  it('detects repeated failing command', () => {
    const g = createShellStallGuard();
    const cmd = 'echo test';
    expect(g.record(cmd, false).stalled).toBe(false);
    expect(g.record(cmd, false).stalled).toBe(false);
    expect(g.record(cmd, false).stalled).toBe(false);
    expect(g.record(cmd, false).stalled).toBe(true);
    expect(g.record(cmd, true).stalled).toBe(false);
    expect(g.record(cmd, false).stalled).toBe(false);
  });

  it('normalizes whitespace', () => {
    expect(normalizeShellCommand('  echo   a  ')).toBe('echo a');
  });
});

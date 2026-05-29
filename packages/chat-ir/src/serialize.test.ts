import { describe, expect, it } from 'vitest';
import { formatMessageTime, formatWallClockTime } from './serialize.js';

describe('formatMessageTime', () => {
  it('renders Asia/Shanghai wall clock, not UTC hours', () => {
    const now = new Date('2026-05-29T13:00:00.000Z');
    const sentAt = '2026-05-29T12:30:00.000Z';
    const tag = formatMessageTime(sentAt, { timeZone: 'Asia/Shanghai', now });
    expect(tag).toContain('20:30');
    expect(tag).not.toContain('12:30');
  });

  it('formatWallClockTime uses explicit timezone for UI', () => {
    const out = formatWallClockTime('2026-05-29T12:30:00.000Z', { timeZone: 'Asia/Shanghai' });
    expect(out).toContain('20:30');
  });
});

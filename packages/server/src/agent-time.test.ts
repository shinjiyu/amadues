import { describe, expect, it } from 'vitest';
import { formatAgentIsoLocal, formatAgentLocalDateTime, formatAgentTimestampShort } from './agent-time.js';

describe('agent-time', () => {
  it('formatAgentLocalDateTime uses explicit Asia/Shanghai', () => {
    const out = formatAgentLocalDateTime(
      new Date('2026-05-29T12:30:00.000Z'),
      'Asia/Shanghai',
    );
    expect(out).toContain('20:30');
    expect(out).toMatch(/GMT\+8|CST|中国标准时间/);
  });

  it('formatAgentIsoLocal converts UTC ISO to local wall clock', () => {
    const out = formatAgentIsoLocal('2026-05-29T12:30:00.000Z', 'Asia/Shanghai');
    expect(out).toContain('20:30');
  });

  it('formatAgentTimestampShort uses Asia/Shanghai wall clock', () => {
    const out = formatAgentTimestampShort(
      new Date('2026-05-29T12:30:00.000Z'),
      'Asia/Shanghai',
    );
    expect(out).toBe('2026-05-29 20:30');
  });
});

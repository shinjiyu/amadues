import { describe, expect, it } from 'vitest';
import { formatAgentIsoLocal, formatAgentLocalDateTime } from './agent-time.js';

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
});

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_AGENT_TIMEZONE,
  formatAgentLocalDateTime,
  formatAgentNowTag,
  resolveAgentTimezone,
} from './agent-time.js';

describe('agent-time', () => {
  it('resolveAgentTimezone 优先 UTLRA_AGENT_TIMEZONE', () => {
    expect(resolveAgentTimezone({ UTLRA_AGENT_TIMEZONE: 'Europe/Berlin', TZ: 'UTC' })).toBe(
      'Europe/Berlin',
    );
  });

  it('无显式配置时默认 Asia/Shanghai', () => {
    expect(resolveAgentTimezone({})).toBe(DEFAULT_AGENT_TIMEZONE);
  });

  it('formatAgentLocalDateTime 使用指定时区', () => {
    const s = formatAgentLocalDateTime(new Date('2026-05-29T10:00:00.000Z'), 'Asia/Shanghai');
    expect(s).toMatch(/2026/);
    expect(s).toMatch(/18:00:00/);
  });

  it('formatAgentNowTag 含时区名', () => {
    const tag = formatAgentNowTag(new Date('2026-05-29T10:00:00.000Z'), 'Asia/Shanghai');
    expect(tag).toContain('Asia/Shanghai');
    expect(tag).toContain('18:00');
  });
});

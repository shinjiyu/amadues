import { describe, expect, it } from 'vitest';

import { isSubjectMode, resolveAgentMode } from './agent-mode.js';

describe('resolveAgentMode', () => {
  it('defaults to servant', () => {
    expect(resolveAgentMode({})).toBe('servant');
    expect(resolveAgentMode({ UTLRA_AGENT_MODE: 'nope' })).toBe('servant');
    expect(isSubjectMode({})).toBe(false);
  });

  it('accepts subject case-insensitively', () => {
    expect(resolveAgentMode({ UTLRA_AGENT_MODE: ' Subject ' })).toBe('subject');
    expect(isSubjectMode({ UTLRA_AGENT_MODE: 'subject' })).toBe(true);
  });
});

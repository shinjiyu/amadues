import { describe, expect, it } from 'vitest';

import {
  formatInnerWorkerExitMessage,
  isTransientLlmTransportError,
} from './llm-transport-error.js';

describe('llm-transport-error', () => {
  it('detects TypeError terminated as transient', () => {
    expect(isTransientLlmTransportError('TypeError: terminated')).toBe(true);
    expect(isTransientLlmTransportError('LLM stream idle timeout: no chunk for 300000ms')).toBe(true);
    expect(isTransientLlmTransportError('chat-stream error 503')).toBe(false);
  });

  it('formats Windows crash exit code', () => {
    expect(formatInnerWorkerExitMessage(3221226505)).toContain('0xC0000409');
  });
});

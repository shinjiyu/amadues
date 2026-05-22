import { describe, expect, it } from 'vitest';
import {
  irMessageIdToWebChat,
  irThreadToWebChat,
  isWebChatIrThread,
  webChatMessageIdToIr,
  webChatThreadToIr,
} from './thread-mapper.js';

describe('thread-mapper', () => {
  it('round-trips thread ids', () => {
    expect(webChatThreadToIr('global')).toBe('webchat:global');
    expect(irThreadToWebChat('webchat:global')).toBe('global');
    expect(webChatThreadToIr('dm:alice:bob')).toBe('webchat:dm:alice:bob');
    expect(irThreadToWebChat('webchat:dm:alice:bob')).toBe('dm:alice:bob');
  });

  it('returns null for non-webchat IR threads', () => {
    expect(irThreadToWebChat('discord:abc')).toBeNull();
    expect(irThreadToWebChat('thread:uuid')).toBeNull();
    expect(isWebChatIrThread('discord:abc')).toBe(false);
    expect(isWebChatIrThread('webchat:dm:a:b')).toBe(true);
  });

  it('round-trips message ids', () => {
    expect(webChatMessageIdToIr('abc-uuid')).toBe('webchat:abc-uuid');
    expect(irMessageIdToWebChat('webchat:abc-uuid')).toBe('abc-uuid');
    expect(irMessageIdToWebChat('discord:xyz')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { dmThreadId, isDmParticipant, isDmThreadId, parseDmThreadId } from './ids.js';

describe('dmThreadId', () => {
  it('sorts userIds deterministically', () => {
    expect(dmThreadId('alice', 'bob')).toBe('dm:alice:bob');
    expect(dmThreadId('bob', 'alice')).toBe('dm:alice:bob');
  });

  it('throws on self DM', () => {
    expect(() => dmThreadId('a', 'a')).toThrow();
  });

  it('throws on empty user_id', () => {
    expect(() => dmThreadId('', 'b')).toThrow();
  });
});

describe('parseDmThreadId', () => {
  it('returns the original two users', () => {
    expect(parseDmThreadId('dm:alice:bob')).toEqual(['alice', 'bob']);
  });

  it('returns null for non-dm thread', () => {
    expect(parseDmThreadId('global')).toBeNull();
    expect(parseDmThreadId('dm:')).toBeNull();
    expect(parseDmThreadId('dm:onlyone')).toBeNull();
  });
});

describe('isDmThreadId / isDmParticipant', () => {
  it('classifies thread ids', () => {
    expect(isDmThreadId('global')).toBe(false);
    expect(isDmThreadId('dm:a:b')).toBe(true);
  });

  it('checks participation', () => {
    expect(isDmParticipant('dm:alice:bob', 'alice')).toBe(true);
    expect(isDmParticipant('dm:alice:bob', 'bob')).toBe(true);
    expect(isDmParticipant('dm:alice:bob', 'charlie')).toBe(false);
    expect(isDmParticipant('global', 'alice')).toBe(false);
  });
});

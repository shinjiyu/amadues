import { describe, expect, it } from 'vitest';
import { buildParts } from './parts-builder.js';
import type { User } from '@utlra/webchat-protocol';

const users: User[] = [
  { user_id: 'alice', display_name: 'Alice', created_at: '2026-01-01T00:00:00.000Z' },
  { user_id: 'bob', display_name: 'Bob', created_at: '2026-01-01T00:00:00.000Z' },
];

const resolveUser = (uid: string): User | undefined => users.find((u) => u.user_id === uid);

describe('buildParts', () => {
  it('plain text passthrough', () => {
    const r = buildParts({
      text: 'hello world',
      parts: undefined,
      mentionUserIds: [],
      attachments: [],
      resolveUser,
    });
    expect(r.parts).toEqual([{ type: 'text', text: 'hello world' }]);
    expect(r.text).toBe('hello world');
    expect(r.mentions).toEqual([]);
  });

  it('replaces @DisplayName tokens with mention parts', () => {
    const r = buildParts({
      text: 'hello @Bob, how are you',
      parts: undefined,
      mentionUserIds: ['bob'],
      attachments: [],
      resolveUser,
    });
    expect(r.parts).toEqual([
      { type: 'text', text: 'hello ' },
      { type: 'mention', user_id: 'bob', display_name: 'Bob' },
      { type: 'text', text: ', how are you' },
    ]);
    expect(r.mentions).toEqual([{ user_id: 'bob', display_name: 'Bob' }]);
  });

  it('appends mentions not present in text', () => {
    const r = buildParts({
      text: 'hello world',
      parts: undefined,
      mentionUserIds: ['alice'],
      attachments: [],
      resolveUser,
    });
    expect(r.parts).toEqual([
      { type: 'text', text: 'hello world' },
      { type: 'mention', user_id: 'alice', display_name: 'Alice' },
    ]);
  });

  it('appends attachments at the end', () => {
    const r = buildParts({
      text: 'see this',
      parts: undefined,
      mentionUserIds: [],
      attachments: [
        { asset_id: 'a1', url: '/uploads/a1', mime: 'image/png', name: 'x.png', size: 10 },
      ],
      resolveUser,
    });
    expect(r.parts).toHaveLength(2);
    expect(r.parts[1]?.type).toBe('attachment');
  });

  it('honors client-provided parts and supplements mentions', () => {
    const r = buildParts({
      text: undefined,
      parts: [{ type: 'text', text: 'manual ' }, { type: 'text', text: 'parts' }],
      mentionUserIds: ['alice'],
      attachments: [],
      resolveUser,
    });
    expect(r.parts).toHaveLength(3);
    expect(r.parts[2]).toEqual({ type: 'mention', user_id: 'alice', display_name: 'Alice' });
  });
});

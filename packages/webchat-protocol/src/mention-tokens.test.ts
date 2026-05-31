import { describe, expect, it } from 'vitest';
import { resolveMentionUserIdsFromText } from './mention-tokens.js';

const users = [
  { user_id: 'kuroneko', display_name: 'Kuroneko' },
  { user_id: 'kuro', display_name: 'Kuro' },
  { user_id: 'gin', display_name: 'Gin' },
];

describe('resolveMentionUserIdsFromText', () => {
  it('does not treat @Kuroneko as @Kuro', () => {
    expect(resolveMentionUserIdsFromText('@Kuroneko 你好', users)).toEqual(['kuroneko']);
  });

  it('matches display_name and user_id case-insensitively', () => {
    expect(resolveMentionUserIdsFromText('hi @kuro', users)).toEqual(['kuro']);
    expect(resolveMentionUserIdsFromText('hi @KURO', users)).toEqual(['kuro']);
  });

  it('strips trailing punctuation from tokens', () => {
    expect(resolveMentionUserIdsFromText('hello @Kuroneko, 在吗', users)).toEqual(['kuroneko']);
  });

  it('dedupes repeated mentions', () => {
    expect(resolveMentionUserIdsFromText('@Gin @gin', users)).toEqual(['gin']);
  });

  it('excludes self', () => {
    expect(resolveMentionUserIdsFromText('@Kuroneko', users, 'kuroneko')).toEqual([]);
  });
});

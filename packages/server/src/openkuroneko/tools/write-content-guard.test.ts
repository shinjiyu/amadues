import { describe, expect, it } from 'vitest';

import {
  formatSlimWriteFileRef,
  isRejectedWriteContent,
  normalizeWorkRelPath,
  SLIM_REF_PREFIX,
} from './write-content-guard.js';

describe('isRejectedWriteContent', () => {
  it('rejects legacy [N chars omitted] placeholder', () => {
    expect(isRejectedWriteContent('[3410 chars omitted; file on disk at workspace/ch2.txt]')).toBe(true);
  });

  it('rejects __SLIM_REF__ format', () => {
    expect(isRejectedWriteContent(formatSlimWriteFileRef('workspace/ch2.txt'))).toBe(true);
    expect(isRejectedWriteContent(`${SLIM_REF_PREFIX}bot.cjs`)).toBe(true);
  });

  it('allows normal prose', () => {
    expect(isRejectedWriteContent('第1章 重生\n\n正文…')).toBe(false);
  });
});

describe('normalizeWorkRelPath', () => {
  it('normalizes relative paths', () => {
    expect(normalizeWorkRelPath('/tmp/ws', 'workspace/ch1.txt')).toBe('workspace/ch1.txt');
  });
});

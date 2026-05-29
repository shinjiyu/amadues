import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { searchFilesUnderRoot } from './file-search.js';

describe('searchFilesUnderRoot', () => {
  it('finds regex matches under root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-search-'));
    try {
      fs.writeFileSync(path.join(root, 'a.md'), 'hello world\nsecond line\n', 'utf8');
      fs.writeFileSync(path.join(root, 'b.txt'), 'no match\n', 'utf8');
      const hits = searchFilesUnderRoot({ root, query: 'hello', glob: '*.md' });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.path).toBe('a.md');
      expect(hits[0]?.line).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

import { describe, expect, it } from 'vitest';

import { truncatePage } from './html-parser.js';

describe('web_search fetch limit', () => {
  it('truncatePage defaults to 8000 but tool uses 4000 via index', () => {
    const text = 'a'.repeat(5000);
    expect(truncatePage(text, 4000).length).toBeLessThan(5000);
    expect(truncatePage(text, 4000)).toContain('[...truncated]');
  });
});

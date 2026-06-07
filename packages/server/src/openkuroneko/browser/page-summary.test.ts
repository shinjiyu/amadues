import { describe, expect, it } from 'vitest';

import { formatA11yTree, inlinePageSummary } from './page-summary.js';

describe('page-summary', () => {
  it('formats accessibility tree with depth limit', () => {
    const tree = formatA11yTree({
      role: 'WebArea',
      name: 'Fixture',
      children: [
        { role: 'heading', name: '欢迎' },
        { role: 'button', name: '提交' },
      ],
    });
    expect(tree).toContain('heading "欢迎"');
    expect(tree).toContain('button "提交"');
  });

  it('builds inline summary', () => {
    const s = inlinePageSummary('https://x/', 'T', '- button "提交"');
    expect(s).toContain('url=https://x/');
    expect(s).toContain('title=T');
  });
});

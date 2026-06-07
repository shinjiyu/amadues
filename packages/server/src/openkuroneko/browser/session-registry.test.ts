import { afterEach, describe, expect, it } from 'vitest';

import {
  __resetBrowserSessionsForTests,
  __sessionCountForTests,
  closeBrowserSessionsForNode,
  openBrowserSession,
} from './session-registry.js';
import { clearBrowserSessionScope, setBrowserSessionScope } from './session-scope.js';

describe('browser session-registry', () => {
  afterEach(async () => {
    await closeBrowserSessionsForNode('any');
    clearBrowserSessionScope();
    __resetBrowserSessionsForTests();
  });

  it('rejects open without scope', async () => {
    clearBrowserSessionScope();
    const r = await openBrowserSession();
    expect(r.ok).toBe(false);
    expect(r.output).toContain('scope not set');
  });

  it('enforces max sessions per workDir', async () => {
    setBrowserSessionScope('/tmp/wd-a', 'n1');
    const prev = process.env['INNER_BROWSER_MAX_PER_WORKDIR'];
    process.env['INNER_BROWSER_MAX_PER_WORKDIR'] = '1';

    try {
      const first = await openBrowserSession({ headless: true });
      expect(first.ok).toBe(true);
      const second = await openBrowserSession({ headless: true });
      expect(second.ok).toBe(false);
      expect(second.output).toContain('max browser sessions');
    } finally {
      if (prev === undefined) delete process.env['INNER_BROWSER_MAX_PER_WORKDIR'];
      else process.env['INNER_BROWSER_MAX_PER_WORKDIR'] = prev;
      await closeBrowserSessionsForNode('n1');
    }
  });

  it('closeBrowserSessionsForNode clears registry', async () => {
    setBrowserSessionScope('/tmp/wd-b', 'node-x');
    const opened = await openBrowserSession({ headless: true });
    expect(opened.ok).toBe(true);
    expect(__sessionCountForTests()).toBe(1);
    const n = await closeBrowserSessionsForNode('node-x');
    expect(n).toBe(1);
    expect(__sessionCountForTests()).toBe(0);
  });
});

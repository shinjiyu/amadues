import { describe, expect, it } from 'vitest';

import {
  normalizePlaybookSteps,
  parseInlineStepsArg,
  stepToActArgs,
} from './browser-playbook.js';

describe('browser-playbook', () => {
  it('parses inline steps array', () => {
    const r = parseInlineStepsArg([
      { action: 'goto', url: 'https://example.com' },
      { action: 'click', text: 'OK' },
    ]);
    expect('steps' in r).toBe(true);
    if ('steps' in r) {
      expect(r.steps).toHaveLength(2);
      expect(r.steps[0]?.action).toBe('goto');
    }
  });

  it('parses wrapped playbook object', () => {
    const r = normalizePlaybookSteps({
      label: 'x',
      steps: [{ action: 'state' }],
    });
    expect('steps' in r).toBe(true);
    if ('steps' in r) expect(r.steps[0]?.action).toBe('state');
  });

  it('rejects unknown action', () => {
    const r = normalizePlaybookSteps([{ action: 'fly' }]);
    expect('error' in r).toBe(true);
  });

  it('stepToActArgs strips action field', () => {
    const args = stepToActArgs({ action: 'fill', selector: '#t', value: 'hi' });
    expect(args).toEqual({ selector: '#t', value: 'hi' });
  });
});

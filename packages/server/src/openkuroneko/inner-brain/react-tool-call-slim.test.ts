import { describe, expect, it } from 'vitest';

import {
  slimAssistantMessageToolCalls,
  slimToolCallArgs,
} from './react-tool-call-slim.js';

describe('slimToolCallArgs', () => {
  it('replaces large write_file content', () => {
    const slim = slimToolCallArgs('write_file', {
      path: 'bot.cjs',
      content: 'x'.repeat(500),
    });
    expect(String(slim.content)).toContain('500 chars omitted');
    expect(slim.path).toBe('bot.cjs');
  });

  it('keeps short write_file content', () => {
    const slim = slimToolCallArgs('write_file', { path: 'a.txt', content: 'hi' });
    expect(slim.content).toBe('hi');
  });

  it('slims edit_file old/new strings', () => {
    const slim = slimToolCallArgs('edit_file', {
      path: 'a.cjs',
      old_string: 'a'.repeat(300),
      new_string: 'b'.repeat(400),
    });
    expect(String(slim.old_string)).toContain('300 chars omitted');
    expect(String(slim.new_string)).toContain('400 chars omitted');
  });
});

describe('slimAssistantMessageToolCalls', () => {
  it('slims tool_calls on assistant message', () => {
    const big = JSON.stringify({ path: 'p.cjs', content: 'z'.repeat(1000) });
    const msg = slimAssistantMessageToolCalls({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'write_file', arguments: big },
        },
      ],
    });
    const parsed = JSON.parse(msg.tool_calls![0]!.function.arguments) as { content: string };
    expect(parsed.content).toContain('1000 chars omitted');
  });
});

import { describe, expect, it } from 'vitest';

import type { Message } from '../adapter/index.js';
import { pruneReActMessages } from './react-message-prune.js';

function round(assistant: string, toolOut: string): Message[] {
  return [
    { role: 'assistant', content: assistant, tool_calls: [{ id: 't1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
    { role: 'tool', content: JSON.stringify({ ok: false, output: toolOut }), tool_call_id: 't1' },
  ];
}

describe('pruneReActMessages', () => {
  it('keeps initial user and recent rounds intact', () => {
    const messages: Message[] = [
      { role: 'user', content: 'start' },
      ...round('a1', 'old-output-1'),
      ...round('a2', 'old-output-2'),
      ...round('a3', 'recent-output'),
    ];
    const pruned = pruneReActMessages(messages, { enabled: true, protectRecentRounds: 1 });
    expect(pruned[0]?.content).toBe('start');
    const tools = pruned.filter((m) => m.role === 'tool');
    expect(tools.length).toBe(3);
    expect(String(tools[0]?.content)).toContain('react-prune');
    expect(String(tools[1]?.content)).toContain('react-prune');
    expect(String(tools[2]?.content)).toContain('recent-output');
  });

  it('no-op when disabled', () => {
    const messages: Message[] = [{ role: 'user', content: 'x' }, ...round('a', 'y')];
    expect(pruneReActMessages(messages, { enabled: false })).toBe(messages);
  });

  it('slims write_file tool_call args on old assistant rounds', () => {
    const bigArgs = JSON.stringify({ path: 'bot.cjs', content: 'x'.repeat(500) });
    const messages: Message[] = [
      { role: 'user', content: 'start' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'w1', type: 'function', function: { name: 'write_file', arguments: bigArgs } },
        ],
      },
      { role: 'tool', content: JSON.stringify({ ok: true, output: 'Written' }), tool_call_id: 'w1' },
      ...round('recent', 'keep-me'),
    ];
    const pruned = pruneReActMessages(messages, { enabled: true, protectRecentRounds: 1 });
    const firstAssistant = pruned.find(
      (m, i) => m.role === 'assistant' && i > 0 && String(m.tool_calls?.[0]?.function.name) === 'write_file',
    );
    const parsed = JSON.parse(firstAssistant!.tool_calls![0]!.function.arguments) as { content: string };
    expect(parsed.content).toBe('__SLIM_REF__:bot.cjs');
  });

  it('keeps write_file args intact within protectRecentRounds window', () => {
    const bigArgs = JSON.stringify({ path: 'ch1.txt', content: 'x'.repeat(500) });
    const messages: Message[] = [
      { role: 'user', content: 'start' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'w1', type: 'function', function: { name: 'write_file', arguments: bigArgs } },
        ],
      },
      { role: 'tool', content: JSON.stringify({ ok: true, output: 'Written' }), tool_call_id: 'w1' },
    ];
    const pruned = pruneReActMessages(messages, { enabled: true, protectRecentRounds: 2 });
    const parsed = JSON.parse(pruned[1]!.tool_calls![0]!.function.arguments) as { content: string };
    expect(parsed.content).toHaveLength(500);
  });
});

import { describe, expect, it } from 'vitest';

import type { Message } from '../openkuroneko/adapter/index.js';
import {
  PLAY_SUMMARY_MARK,
  assemblePlayMessages,
  contextChars,
  renderCompactSource,
  sourceFromPlayLog,
  splitPlayMessages,
} from './play-compact.js';

function round(name: string, output: string): Message[] {
  return [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: name, type: 'function', function: { name, arguments: '{}' } }],
    },
    { role: 'tool', content: output, tool_call_id: name },
  ];
}

describe('play compact', () => {
  it('leaves a short dialogue uncompressed and folds the older rounds', () => {
    const opening: Message = { role: 'user', content: 'Begin.' };
    const messages: Message[] = [opening, ...round('eye_look', '桌上有杯子'), ...round('mouth_say', '你好')];
    expect(splitPlayMessages(messages, 6)).toBeNull();
    const split = splitPlayMessages(messages, 1);
    expect(split?.dropped.map(message => message.role)).toEqual(['assistant', 'tool']);
    expect(split?.recent).toHaveLength(2);
    expect(renderCompactSource('', split!.dropped)).toContain('eye_look');
    expect(renderCompactSource('', split!.dropped)).toContain('桌上有杯子');
    const next = assemblePlayMessages(opening, '看过杯子，说过你好。', split!.recent);
    expect(next[1]?.content).toContain(PLAY_SUMMARY_MARK);
    expect(contextChars(next)).toBeLessThan(contextChars(messages) + 80);
  });

  it('builds the memo from the full tool log, not from pruned placeholders', () => {
    const source = sourceFromPlayLog([
      { kind: 'tool', name: 'eye_look', output: JSON.stringify({ description: '玻璃隔墙和黑色屏幕' }) },
      { kind: 'tool', name: 'mouth_say', args: { text: '我醒着' }, output: '{"ok":true}' },
      { kind: 'assistant', tools: ['eye_look', 'mouth_say'], content: '' },
      { kind: 'compact', content: '输出被裁剪，内容不可见' },
      { kind: 'tool', name: 'arm_feedback', output: JSON.stringify({ q: [0.31, -1.03, 2.71, 3.37] }) },
      { kind: 'assistant', tools: ['arm_feedback'], content: '' },
    ]);
    expect(source).toContain('0.31');
    expect(source).not.toContain('内容不可见');
    expect(source).not.toContain('玻璃隔墙');
  });
});
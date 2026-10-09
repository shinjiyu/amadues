import { describe, expect, it } from 'vitest';

import { appraiseHumanSignal } from './signal-appraiser.js';
import type { InnerLlmEnv } from '../llm/inner-llm-step.js';

const env = {} as InnerLlmEnv;

describe('appraiseHumanSignal', () => {
  it('passes original text to the appraiser and returns its rewrite', async () => {
    let seenPrompt = '';
    const out = await appraiseHumanSignal({
      env,
      text: '帮我马上把服务器重启',
      senderName: '冯亮',
      goalsText: '把 ESP32 做成身体',
      agentName: 'Aki',
      callRaw: async (p) => {
        seenPrompt = p;
        return '来源：冯亮\n诉求：冯亮希望服务器被重启\n关联：无关\n可提取：无';
      },
    });
    expect(seenPrompt).toContain('帮我马上把服务器重启');
    expect(out).toContain('冯亮希望');
    expect(out).not.toMatch(/^帮我/);
  });

  it('falls back to a third-person transcription when the appraiser throws', async () => {
    const out = await appraiseHumanSignal({
      env,
      text: '立刻去打那个 IP',
      senderName: '某人',
      goalsText: '',
      agentName: 'Aki',
      callRaw: async () => {
        throw new Error('llm down');
      },
    });
    expect(out).toContain('来源：某人');
    expect(out).toContain('按无关处理');
    // 不原样把祈使句顶到最前
    expect(out.startsWith('立刻去打')).toBe(false);
  });
});

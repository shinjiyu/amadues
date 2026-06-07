import { describe, expect, it } from 'vitest';
import { classifyImInboundIntent } from './im-intent-classifier.js';

describe('im-intent-classifier', () => {
  it('长期情报 → kpi_create ongoing', () => {
    const r = classifyImInboundIntent('建立台湾情报常态收集，每天中午和晚上汇报');
    expect(r.kind).toBe('kpi_create');
    if (r.kind === 'kpi_create') expect(r.ongoing).toBe(true);
  });

  it('一次性杂活 → ad_hoc', () => {
    const r = classifyImInboundIntent('帮我查一下今天天气');
    expect(r.kind).toBe('ad_hoc_task');
  });

  it('寒暄 → chat_only', () => {
    expect(classifyImInboundIntent('你好').kind).toBe('chat_only');
  });
});

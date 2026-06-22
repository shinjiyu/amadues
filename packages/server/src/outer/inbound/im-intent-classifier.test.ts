import { describe, expect, it } from 'vitest';
import { classifyImInboundIntent, isKpiQueryIntent } from './im-intent-classifier.js';

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

  it('汇报当前 KPI（含 @mention）→ chat_only，不建 KPI', () => {
    const msg = '@Gin @Kuroneko @元宝 @Aoi 汇报你们当前的KPI';
    expect(isKpiQueryIntent(msg)).toBe(true);
    expect(classifyImInboundIntent(msg).kind).toBe('chat_only');
  });

  it('查看 KPI 进展 → chat_only', () => {
    expect(classifyImInboundIntent('当前 KPI 进展怎么样').kind).toBe('chat_only');
  });

  it('仅提到 KPI 一词 → chat_only', () => {
    expect(classifyImInboundIntent('你们 KPI 呢').kind).toBe('chat_only');
  });
});

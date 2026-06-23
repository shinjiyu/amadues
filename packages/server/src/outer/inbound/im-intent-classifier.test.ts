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

  // ── IM-INBOUND-INTENT-ROUTING.md 回归用例 ──

  it('裸「启动项目」→ chat_only（不再误建 KPI）', () => {
    expect(classifyImInboundIntent('再试一下启动刚下载的项目').kind).toBe('chat_only');
    expect(classifyImInboundIntent('启动一下那个项目吧').kind).toBe('chat_only');
  });

  it('裸「设定/新增」→ chat_only（收窄正则）', () => {
    expect(classifyImInboundIntent('设定一个新增的小功能').kind).toBe('chat_only');
  });

  it('纯确认追问 → chat_only', () => {
    expect(classifyImInboundIntent('我看到你已经成功启动了，是这样么？').kind).toBe('chat_only');
  });

  it('追问 + 有在跑任务 → task_followup（不新建）', () => {
    const ctx = {
      followupRef: { kind: 'burst' as const, id: 'ib-x', matchReason: 'in_flight' as const },
    };
    const r = classifyImInboundIntent('那个项目怎么样了？', ctx);
    expect(r.kind).toBe('task_followup');
    if (r.kind === 'task_followup') expect(r.ref.id).toBe('ib-x');
  });

  it('显式 KPI 但已有近似 active KPI → kpi_update（去重）', () => {
    const ctx = {
      activeKpis: [{ kpiId: 'kpi-tw', description: '台湾情报常态收集，每天中午晚上汇报' }],
    };
    const r = classifyImInboundIntent('继续做台湾情报常态收集，每天汇报', ctx);
    expect(r.kind).toBe('kpi_update');
    if (r.kind === 'kpi_update') expect(r.kpiId).toBe('kpi-tw');
  });

  it('kpi_create 仅产 ongoing', () => {
    const r = classifyImInboundIntent('建立长期监控机制，每天汇报简报');
    expect(r.kind).toBe('kpi_create');
    if (r.kind === 'kpi_create') {
      expect(r.ongoing).toBe(true);
      expect(r.confirmed).toBe(true);
    }
  });
});

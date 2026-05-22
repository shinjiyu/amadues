/**
 * ADL component: kpiRegistry — create / attach / persist
 */
import { afterEach, describe, expect, it } from 'vitest';

import { createTestDataRoot, type TestDataRoot } from '../testing/temp-data-root.js';
import { KpiRegistry } from './kpi-registry.js';

describe('component: kpiRegistry', () => {
  let root: TestDataRoot;

  afterEach(() => {
    root?.cleanup();
  });

  it('create → get 主路径', () => {
    root = createTestDataRoot('kpi-reg-');
    const reg = new KpiRegistry(root.dataRoot);
    const k = reg.create({ description: '测试 KPI', createdBy: 'test' });
    expect(k.status).toBe('active');
    expect(reg.get(k.kpiId)?.description).toBe('测试 KPI');
  });

  it('attachBurst + update achieved 持久化', () => {
    root = createTestDataRoot('kpi-reg-');
    const reg1 = new KpiRegistry(root.dataRoot);
    const { kpiId } = reg1.create({ description: '归档', createdBy: 'test' });
    reg1.attachBurst(kpiId, 'ib-abc');
    reg1.update(kpiId, { status: 'achieved' });

    const reg2 = new KpiRegistry(root.dataRoot);
    const k = reg2.get(kpiId)!;
    expect(k.bursts).toContain('ib-abc');
    expect(k.status).toBe('achieved');
  });
});

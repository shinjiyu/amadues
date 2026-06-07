/**
 * 首次 KPI 推进时拆分子 KPI — ADL KPI-ADVANCEMENT.md §3
 */
import type { KpiCadence, KpiRecord, KpiRegistry } from '../kpi-registry.js';

export interface SubKpiSpec {
  description: string;
  cadence: KpiCadence;
  charter?: string;
}

const COLLECT_RE = /采集|收集|滚动|更新|监控|抓取|intel|情报源/i;
const REPORT_RE = /汇报|简报|日报|报告|brief|12[:：]00|21[:：]00|中午|晚上/i;

/** 从父 KPI 描述启发式拆子 KPI（无 LLM 依赖，可后续换 LLM） */
export function planSubKpisFromParent(parent: KpiRecord): SubKpiSpec[] {
  const text = `${parent.description}\n${parent.notes ?? ''}`;
  const hasCollect = COLLECT_RE.test(text);
  const hasReport = REPORT_RE.test(text);

  if (parent.kind === 'delivery') {
    return [{ description: parent.description, cadence: { type: 'once' } }];
  }

  if (hasCollect && hasReport) {
    const specs: SubKpiSpec[] = [
      {
        description: `${parent.description} — 增量采集 sprint`,
        cadence: { type: 'interval', everyMs: 3 * 60 * 60 * 1000 },
        charter: '本轮只做增量采集：更新已有维度文件，完成后 DONE。',
      },
      {
        description: `${parent.description} — 定时简报 sprint`,
        cadence: { type: 'cron', hours: [12, 21], tz: 'Asia/Shanghai' },
        charter: '本轮只写简报：读取 workspace 增量，产出 daily_brief，完成后 DONE。',
      },
    ];
    return specs;
  }

  if (hasReport && !hasCollect) {
    return [{
      description: parent.description,
      cadence: { type: 'cron', hours: [12, 21], tz: 'Asia/Shanghai' },
      charter: parent.charter,
    }];
  }

  return [{
    description: parent.description,
    cadence: { type: 'continuous', minGapMs: 3 * 60 * 60 * 1000 },
    charter: parent.charter ?? '本轮 EXECUTE 只向 KPI 靠近一小步，完成后 DONE。',
  }];
}

/**
 * 父 KPI 首拆：创建子 KPI 并返回 leaf id 列表。
 * 若已有 children 则直接返回。
 */
export function decomposeParentKpiIfNeeded(
  kpiRegistry: KpiRegistry,
  parentId: string,
): string[] {
  const parent = kpiRegistry.get(parentId);
  if (!parent) return [];
  if (parent.isLeaf) return [parent.kpiId];
  if (parent.children && parent.children.length > 0) {
    return parent.children;
  }

  const specs = planSubKpisFromParent(parent);
  const childIds: string[] = [];
  for (const spec of specs) {
    const child = kpiRegistry.createChild(parentId, {
      description: spec.description,
      createdBy: parent.createdBy,
      kind: parent.kind,
      notes: parent.notes,
      cadence: spec.cadence,
      charter: spec.charter,
    });
    if (child) childIds.push(child.kpiId);
  }
  return childIds;
}

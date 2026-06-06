/**
 * 环境模型 — 传感器注册表 + tick 调度（ADL ENVIRONMENT-MODEL.md §3-5）。
 *
 * collect() 一次 tick：按 cadence 调每个 sensor.read → 组装 EnvironmentSnapshot；
 * 配合 EnvironmentJournal（ring/current/events）+ changeDetector（derived/events）。
 *
 * 不直接 import 业务模块——只读依赖经 SensorContext 注入。
 */
import { runChangeDetection } from './change-detector.js';
import type { EnvironmentJournal } from './journal.js';
import { BUILTIN_SENSORS } from './environment-sensors.js';
import type {
  EnvironmentEvent,
  EnvironmentSensor,
  EnvironmentSnapshot,
  FacetEnvelope,
  SensorContext,
} from './environment-types.js';

export class EnvironmentSensorRegistry {
  private readonly sensors: EnvironmentSensor[] = [];
  /** rate_limited sensor 上次读取时刻（缓存其 facet） */
  private readonly lastReadAt = new Map<string, number>();
  private readonly cachedFacet = new Map<string, { capturedAt: string; data: unknown }>();

  constructor(sensors: EnvironmentSensor[] = BUILTIN_SENSORS) {
    for (const s of sensors) this.register(s);
  }

  register(sensor: EnvironmentSensor): void {
    if (this.sensors.some((s) => s.id === sensor.id)) {
      throw new Error(`duplicate sensor id: ${sensor.id}`);
    }
    this.sensors.push(sensor);
  }

  list(): EnvironmentSensor[] {
    return [...this.sensors];
  }

  /**
   * 一次 tick：读所有 sensor → snapshot；若给 journal 则记录 + 跑 changeDetector（derived/events）。
   * 返回 { snapshot, events }；snapshot.facets[id].derived 已注入。
   */
  collect(
    ctx: SensorContext,
    journal?: EnvironmentJournal,
  ): { snapshot: EnvironmentSnapshot; events: EnvironmentEvent[] } {
    const capturedAt = new Date(ctx.now).toISOString();
    const facets: Record<string, FacetEnvelope> = {};

    for (const sensor of this.sensors) {
      const { data, staleness } = this._readWithCadence(sensor, ctx);
      facets[sensor.id] = {
        sensorId: sensor.id,
        capturedAt,
        data,
        derived: {},
        ...(staleness ? { staleness } : {}),
      };
    }

    const snapshot: EnvironmentSnapshot = { capturedAt, agentId: ctx.agentId, facets };

    if (!journal) return { snapshot, events: [] };

    // ring 必须先纳入本 tick，再算派生（派生量需要含当前点的序列）
    const prev = journal.latest();
    journal.record(snapshot);
    const seriesById = journal.allSeries();
    const { derivedById, events } = runChangeDetection(this.sensors, prev, snapshot, seriesById);
    for (const [id, derived] of Object.entries(derivedById)) {
      const env = snapshot.facets[id];
      if (env) env.derived = derived;
    }
    // snapshot 与 ring 末项同引用，derived 已就地注入；仅重写 current.json
    journal.updateCurrent(snapshot);
    if (events.length > 0) journal.appendEvents(events);

    return { snapshot, events };
  }

  private _readWithCadence(
    sensor: EnvironmentSensor,
    ctx: SensorContext,
  ): { data: unknown; staleness?: 'fresh' | 'cached' | 'stale' } {
    if (sensor.cadence === 'rate_limited') {
      const minInterval = sensor.cadenceConfig?.minIntervalMs ?? 0;
      const last = this.lastReadAt.get(sensor.id) ?? 0;
      const cached = this.cachedFacet.get(sensor.id);
      if (cached && ctx.now - last < minInterval) {
        return { data: cached.data, staleness: 'cached' };
      }
      const data = sensor.read(ctx);
      this.lastReadAt.set(sensor.id, ctx.now);
      this.cachedFacet.set(sensor.id, { capturedAt: new Date(ctx.now).toISOString(), data });
      return { data, staleness: 'fresh' };
    }
    return { data: sensor.read(ctx) };
  }
}

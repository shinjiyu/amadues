/**
 * 环境模型 — 派生指标 + 显著事件检测（ADL ENVIRONMENT-MODEL.md §7）。
 *
 * 全部 deterministic（无 random / LLM），便于单测断言。
 * 派生量计算为可复用纯函数；sensor 的 derive/detectEvents 通过 runChangeDetection 编排。
 */
import type {
  EnvironmentEvent,
  EnvironmentSensor,
  EnvironmentSnapshot,
  FacetSample,
  FacetSeries,
} from './environment-types.js';

const MINUTE_MS = 60_000;

/** 取数值字段（缺失/非数字按 0） */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * 速率：窗口内 (最新值 - 最旧值) / 分钟数。样本不足 2 或时间跨度为 0 → 0。
 */
export function computeRatePerMin<T>(
  samples: FacetSample<T>[],
  pick: (data: T) => number,
): number {
  if (samples.length < 2) return 0;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const minutes = (last.at - first.at) / MINUTE_MS;
  if (minutes <= 0) return 0;
  return (pick(last.data) - pick(first.data)) / minutes;
}

/** 与 N 毫秒前样本的差；找不到足够旧的样本 → 与最旧样本比 */
export function computeDelta<T>(
  samples: FacetSample<T>[],
  pick: (data: T) => number,
  windowMs: number,
): number {
  if (samples.length === 0) return 0;
  const last = samples[samples.length - 1]!;
  const cutoff = last.at - windowMs;
  let baseline = samples[0]!;
  for (const s of samples) {
    if (s.at <= cutoff) baseline = s;
    else break;
  }
  return pick(last.data) - pick(baseline.data);
}

/**
 * 连续超阈值持续分钟数：从最新样本往回，predicate 连续为真的时间跨度。
 * 最新样本不满足 → 0。
 */
export function computeStreakMin<T>(
  samples: FacetSample<T>[],
  predicate: (data: T) => boolean,
): number {
  if (samples.length === 0) return 0;
  const last = samples[samples.length - 1]!;
  if (!predicate(last.data)) return 0;
  let streakStart = last.at;
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i]!;
    if (predicate(s.data)) streakStart = s.at;
    else break;
  }
  return (last.at - streakStart) / MINUTE_MS;
}

/**
 * 滞回阈值穿越：up 为上行阈值，down 为下行阈值（应 < up，默认 up*0.8）。
 * 返回 'up' | 'down' | null。避免在阈值附近抖动反复触发。
 */
export function crossedThreshold(
  prev: number,
  next: number,
  up: number,
  down = up * 0.8,
): 'up' | 'down' | null {
  if (prev < up && next >= up) return 'up';
  if (prev >= down && next < down) return 'down';
  return null;
}

/** warmUp：样本数 < min 时返回 null（防小样本说谎） */
export function withWarmUp<R>(samples: { length: number }, min: number, compute: () => R): R | null {
  return samples.length < min ? null : compute();
}

export { num as pickNumber };

export interface ChangeDetectionResult {
  /** sensorId → 派生量 */
  derivedById: Record<string, Record<string, number>>;
  /** 本 tick 命中的显著事件 */
  events: EnvironmentEvent[];
}

/**
 * 对一组 sensor 跑派生 + 事件检测。
 *
 * @param sensors      已注册 sensor
 * @param prev         上一 tick snapshot（首 tick 为 null）
 * @param next         本 tick snapshot
 * @param seriesById   sensorId → 含本 tick 的历史序列（ring buffer 提供）
 */
export function runChangeDetection(
  sensors: EnvironmentSensor[],
  prev: EnvironmentSnapshot | null,
  next: EnvironmentSnapshot,
  seriesById: Record<string, FacetSeries>,
): ChangeDetectionResult {
  const derivedById: Record<string, Record<string, number>> = {};
  const events: EnvironmentEvent[] = [];

  for (const sensor of sensors) {
    const series = seriesById[sensor.id] ?? { sensorId: sensor.id, samples: [] };
    const nextEnv = next.facets[sensor.id];
    if (!nextEnv) continue;

    if (sensor.derive) {
      try {
        derivedById[sensor.id] = sensor.derive(series);
      } catch {
        derivedById[sensor.id] = {};
      }
    }

    if (sensor.detectEvents) {
      const prevData = prev?.facets[sensor.id]?.data ?? null;
      try {
        const ev = sensor.detectEvents(prevData, nextEnv.data, series, next.capturedAt);
        for (const e of ev) events.push(e);
      } catch {
        /* sensor 事件检测失败不影响其它 */
      }
    }
  }

  return { derivedById, events };
}

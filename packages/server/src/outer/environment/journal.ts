/**
 * 环境模型 — 时序日志（ADL ENVIRONMENT-MODEL.md §6）。
 *
 * 三层留存：
 *   - tick ring buffer（内存，最近 N，默认 64）：供 changeDetector 算派生量
 *   - current.json（覆盖）：Dashboard 实时面板
 *   - events.jsonl（按月轮转，永久）：显著事件，供 strategyPlanner.reflect 消费
 *   - hourly.jsonl（永久）：小时聚合，长程趋势
 *
 * 禁止把每 tick ring buffer 全量落盘；落盘只走「事件 + 聚合」两条稀疏通道。
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  EnvironmentEvent,
  EnvironmentSnapshot,
  FacetSeries,
  HourlyAggregate,
} from './environment-types.js';

const DEFAULT_RING_SIZE = 64;

export interface EnvironmentJournalOptions {
  ringSize?: number;
}

export class EnvironmentJournal {
  private readonly dir: string;
  private readonly ringSize: number;
  private ring: EnvironmentSnapshot[] = [];

  constructor(dataRoot: string, opts: EnvironmentJournalOptions = {}) {
    this.dir = path.join(dataRoot, 'environment');
    this.ringSize = Math.max(2, opts.ringSize ?? DEFAULT_RING_SIZE);
  }

  /** 记录一个 tick snapshot：入 ring + 覆盖 current.json */
  record(snapshot: EnvironmentSnapshot): void {
    this.ring.push(snapshot);
    if (this.ring.length > this.ringSize) {
      this.ring.splice(0, this.ring.length - this.ringSize);
    }
    this._writeCurrent(snapshot);
  }

  /** 仅重写 current.json（不入 ring）；derived 注入后刷新用 */
  updateCurrent(snapshot: EnvironmentSnapshot): void {
    this._writeCurrent(snapshot);
  }

  /** ring 内最近 n 个 snapshot（默认全部） */
  recentSnapshots(n = this.ringSize): EnvironmentSnapshot[] {
    return this.ring.slice(-n);
  }

  latest(): EnvironmentSnapshot | null {
    return this.ring[this.ring.length - 1] ?? null;
  }

  /** 上一 tick（倒数第二个） */
  previous(): EnvironmentSnapshot | null {
    return this.ring.length >= 2 ? this.ring[this.ring.length - 2]! : null;
  }

  /** 把 ring 转成单个 sensor 的历史序列（含最新 tick） */
  seriesFor(sensorId: string): FacetSeries {
    const samples = this.ring
      .map((snap) => {
        const env = snap.facets[sensorId];
        return env ? { at: Date.parse(env.capturedAt), data: env.data } : null;
      })
      .filter((s): s is { at: number; data: unknown } => s !== null && Number.isFinite(s.at));
    return { sensorId, samples };
  }

  /** 所有 sensor 的历史序列（changeDetector 用） */
  allSeries(): Record<string, FacetSeries> {
    const ids = new Set<string>();
    for (const snap of this.ring) for (const id of Object.keys(snap.facets)) ids.add(id);
    const out: Record<string, FacetSeries> = {};
    for (const id of ids) out[id] = this.seriesFor(id);
    return out;
  }

  // ── 显著事件 ──────────────────────────────────────────────────────────────

  private _eventsFile(monthIso: string): string {
    return path.join(this.dir, `events-${monthIso}.jsonl`);
  }

  private _monthOf(iso: string): string {
    return iso.slice(0, 7); // YYYY-MM
  }

  /** 追加显著事件（按事件 at 所在月份轮转） */
  appendEvents(events: EnvironmentEvent[]): void {
    if (events.length === 0) return;
    fs.mkdirSync(this.dir, { recursive: true });
    const byMonth = new Map<string, string[]>();
    for (const e of events) {
      const month = this._monthOf(e.at);
      const arr = byMonth.get(month) ?? [];
      arr.push(JSON.stringify(e));
      byMonth.set(month, arr);
    }
    for (const [month, lines] of byMonth) {
      fs.appendFileSync(this._eventsFile(month), lines.join('\n') + '\n', 'utf8');
    }
  }

  private _listEventFiles(): string[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => /^events-\d{4}-\d{2}\.jsonl$/.test(f))
      .sort()
      .map((f) => path.join(this.dir, f));
  }

  private _readEventsFromFile(file: string): EnvironmentEvent[] {
    try {
      return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as EnvironmentEvent);
    } catch {
      return [];
    }
  }

  /** 最近未被 strategy 消费的事件（consumedByStrategyAt 为空），按时间正序，可限量 */
  recentUnconsumedEvents(limit = 50): EnvironmentEvent[] {
    const all: EnvironmentEvent[] = [];
    for (const file of this._listEventFiles()) {
      for (const e of this._readEventsFromFile(file)) {
        if (!e.consumedByStrategyAt) all.push(e);
      }
    }
    all.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    return all.slice(-limit);
  }

  /**
   * 标记事件已被 strategy 消费：按 (at, sensorId, field) 匹配，写回 consumedByStrategyAt。
   * 重写对应月份文件（事件量稀疏，可接受）。
   */
  markEventsConsumed(events: EnvironmentEvent[], consumedAt = new Date().toISOString()): void {
    if (events.length === 0) return;
    const keys = new Set(events.map((e) => `${e.at}|${e.sensorId}|${e.field}`));
    for (const file of this._listEventFiles()) {
      const rows = this._readEventsFromFile(file);
      let changed = false;
      for (const e of rows) {
        if (!e.consumedByStrategyAt && keys.has(`${e.at}|${e.sensorId}|${e.field}`)) {
          e.consumedByStrategyAt = consumedAt;
          changed = true;
        }
      }
      if (changed) {
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
        fs.renameSync(tmp, file);
      }
    }
  }

  // ── 小时聚合 ──────────────────────────────────────────────────────────────

  appendHourly(aggregates: HourlyAggregate[]): void {
    if (aggregates.length === 0) return;
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, 'hourly.jsonl');
    fs.appendFileSync(file, aggregates.map((a) => JSON.stringify(a)).join('\n') + '\n', 'utf8');
  }

  readHourly(limit = 168): HourlyAggregate[] {
    const file = path.join(this.dir, 'hourly.jsonl');
    try {
      const rows = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as HourlyAggregate);
      return rows.slice(-limit);
    } catch {
      return [];
    }
  }

  // ── current.json ─────────────────────────────────────────────────────────

  private _writeCurrent(snapshot: EnvironmentSnapshot): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const file = path.join(this.dir, 'current.json');
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch {
      /* 落盘失败不致命 */
    }
  }
}

/**
 * 对一组数值样本算小时聚合（纯函数，便于测试与外部 cron 调用）。
 */
export function aggregateHour(
  hour: string,
  sensorId: string,
  field: string,
  values: number[],
): HourlyAggregate {
  if (values.length === 0) {
    return { hour, sensorId, field, count: 0, avg: 0, p50: 0, p95: 0, min: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
  return {
    hour,
    sensorId,
    field,
    count: sorted.length,
    avg: sum / sorted.length,
    p50: pct(50),
    p95: pct(95),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  };
}

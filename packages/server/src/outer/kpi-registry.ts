/**
 * KpiRegistry — 长期 KPI 注册表
 *
 * KPI（Key Performance Indicator）= 给 agent 的一个长期目标，不像 inner-brain 任务那样
 * "一次 burst 跑完就归档"。一个 KPI 会跨越多个 burst：
 *   - 每个 burst 跑完写一份 reflexion（成功/失败/换框架建议）→ 追加到 reflexionTrail
 *   - 连续 N 个 burst idle 且无产出 → progress detector 标记 "卡住"，触发反思 burst
 *   - KPI 本身只有 "active / paused / achieved / abandoned" 四个状态
 *
 * 数据持久化：<dataRoot>/kpi-registry.json（原子写）
 *
 * 这是 Tier 4 改造的核心抓手——decomposer / reflexion / progress detector 都通过 kpiId
 * 关联同一组 burst 的"共享记忆"。
 *
 * 设计文档与改造阶段：packages/server/docs/kpi-reflexion-design.md
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type KpiStatus = 'active' | 'paused' | 'achieved' | 'abandoned';

/**
 * 单次 burst 结束后生成的反思摘要（精简版，原始 reflexion JSON 保留在 archive 里）。
 *
 * 注意：这里有意不引入 reflexion.ts 的类型依赖（避免外脑 ↔ inner-brain 反向耦合）。
 * 双方仅靠这套字段约定通信。
 */
export interface ReflexionSummary {
  /** 反思生成时间 */
  ts: string;
  /** 该 reflexion 所属 burst 的 instanceId */
  burstInstanceId: string;
  /** 总体评价 */
  verdict: 'success' | 'partial' | 'failed';
  /** 硬失败列表（API 拒绝 / 明确错误），下一轮 decomposer 会读到，避免重撞 */
  hardFailures: string[];
  /** 软失败列表（路径没产出但没明确报错），弱权重提示 */
  softFailures: string[];
  /** 给下一轮的策略建议（"换什么方向"） */
  nextStrategy: string;
}

export interface KpiRecord {
  kpiId: string;
  /** 自然语言 KPI 描述（"通过 X 达成 Y"） */
  description: string;
  /** 谁创建（user_id 或 'agent:self' 表示 agent 自驱） */
  createdBy: string;
  createdAt: string;
  status: KpiStatus;
  /** 完成 / 放弃时间 */
  finalizedAt?: string;
  /** 完成原因 / 放弃原因 */
  finalizedReason?: string;
  /** 已关联的 inner-brain instanceId 列表，按追加顺序 */
  bursts: string[];
  /** 最近一次 burst 结束时间 */
  lastBurstAt?: string;
  /**
   * 连续 idle 且无产出的 burst 数。任何一次有 deliverable 产出或换 strategy 的 burst
   * 会把这个值重置为 0；progress detector 用它判断是否触发反思 burst。
   */
  consecutiveIdleBursts: number;
  /** 反思轨迹：按时间正序追加。retrieve 时取最近 N 条供 decomposer 参考 */
  reflexionTrail: ReflexionSummary[];
  /** 用户可选填的附加约束 / 提示（自由文本，会拼进 burst 的 constraints） */
  notes?: string;
}

export interface CreateKpiInput {
  description: string;
  createdBy: string;
  notes?: string;
}

export class KpiRegistry {
  private readonly registryPath: string;
  private readonly kpis: Map<string, KpiRecord> = new Map();

  constructor(private readonly dataRoot: string) {
    this.registryPath = path.join(dataRoot, 'kpi-registry.json');
    this._load();
  }

  private _load(): void {
    if (!fs.existsSync(this.registryPath)) return;
    try {
      const rows = JSON.parse(fs.readFileSync(this.registryPath, 'utf8')) as KpiRecord[];
      for (const r of rows) this.kpis.set(r.kpiId, this._normalize(r));
    } catch {
      // 文件损坏时从空状态启动，旧文件留在原地供事后排查
    }
  }

  /** 老版本数据补字段，确保新字段不为 undefined（向下兼容） */
  private _normalize(r: KpiRecord): KpiRecord {
    return {
      ...r,
      bursts: r.bursts ?? [],
      consecutiveIdleBursts: r.consecutiveIdleBursts ?? 0,
      reflexionTrail: r.reflexionTrail ?? [],
    };
  }

  private _save(): void {
    try {
      fs.mkdirSync(this.dataRoot, { recursive: true });
      const tmp = this.registryPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(Array.from(this.kpis.values()), null, 2), 'utf8');
      fs.renameSync(tmp, this.registryPath);
    } catch {
      // 写入失败不致命；下次 _save 还会再试
    }
  }

  /** 生成唯一 KPI ID：`kpi-<ts36>-<rand4>` */
  generateKpiId(): string {
    const ts = Date.now().toString(36);
    const rand = crypto.randomBytes(2).toString('hex');
    return `kpi-${ts}-${rand}`;
  }

  /** 创建 KPI；status 默认 active */
  create(input: CreateKpiInput): KpiRecord {
    const kpi: KpiRecord = {
      kpiId: this.generateKpiId(),
      description: input.description.trim(),
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
      status: 'active',
      bursts: [],
      consecutiveIdleBursts: 0,
      reflexionTrail: [],
      notes: input.notes?.trim() || undefined,
    };
    this.kpis.set(kpi.kpiId, kpi);
    this._save();
    return kpi;
  }

  get(kpiId: string): KpiRecord | undefined {
    return this.kpis.get(kpiId);
  }

  /** 列表查询，可选按 status 过滤；按创建时间降序 */
  list(filter?: { status?: KpiStatus }): KpiRecord[] {
    const all = Array.from(this.kpis.values());
    const filtered = filter?.status ? all.filter((k) => k.status === filter.status) : all;
    return filtered.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  /** 部分字段更新 */
  update(kpiId: string, patch: Partial<KpiRecord>): void {
    const k = this.kpis.get(kpiId);
    if (!k) return;
    Object.assign(k, patch);
    this._save();
  }

  /** 把一个 burst 关联到 KPI（去重） */
  attachBurst(kpiId: string, instanceId: string): void {
    const k = this.kpis.get(kpiId);
    if (!k) return;
    if (!k.bursts.includes(instanceId)) {
      k.bursts.push(instanceId);
    }
    k.lastBurstAt = new Date().toISOString();
    this._save();
  }

  /**
   * 记录一次 idle 无产出的 burst；返回更新后的 streak。
   * Caller 用返回值判断是否达到阈值需要触发反思 burst。
   */
  recordIdle(kpiId: string): number {
    const k = this.kpis.get(kpiId);
    if (!k) return 0;
    k.consecutiveIdleBursts += 1;
    this._save();
    return k.consecutiveIdleBursts;
  }

  /** 任何有产出的 burst 结束时调用，重置 streak */
  resetIdle(kpiId: string): void {
    const k = this.kpis.get(kpiId);
    if (!k) return;
    if (k.consecutiveIdleBursts !== 0) {
      k.consecutiveIdleBursts = 0;
      this._save();
    }
  }

  /** 追加一条 reflexion 摘要到 trail */
  appendReflexion(kpiId: string, summary: ReflexionSummary): void {
    const k = this.kpis.get(kpiId);
    if (!k) return;
    k.reflexionTrail.push(summary);
    this._save();
  }

  /** 取 trail 最近 N 条，按时间倒序（最新的在前） */
  recentReflexions(kpiId: string, n = 5): ReflexionSummary[] {
    const k = this.kpis.get(kpiId);
    if (!k) return [];
    return k.reflexionTrail.slice(-n).reverse();
  }

  /** 主动放弃 KPI（用户或 agent 反思后判定不可达） */
  abandon(kpiId: string, reason?: string): void {
    const k = this.kpis.get(kpiId);
    if (!k) return;
    k.status = 'abandoned';
    k.finalizedAt = new Date().toISOString();
    k.finalizedReason = reason?.trim() || undefined;
    this._save();
  }

  /** 标记达成 */
  markAchieved(kpiId: string, evidence?: string): void {
    const k = this.kpis.get(kpiId);
    if (!k) return;
    k.status = 'achieved';
    k.finalizedAt = new Date().toISOString();
    k.finalizedReason = evidence?.trim() || undefined;
    this._save();
  }

  /** 暂停 / 恢复 */
  pause(kpiId: string): void {
    this.update(kpiId, { status: 'paused' });
  }
  resume(kpiId: string): void {
    const k = this.kpis.get(kpiId);
    if (!k || k.status !== 'paused') return;
    k.status = 'active';
    this._save();
  }
}

/** 将 KPI 反思轨迹格式化为可注入 goal.md 的 Markdown 块 */
export function formatKpiReflexionBlock(summaries: ReflexionSummary[]): string {
  if (summaries.length === 0) return '';
  const lines: string[] = [
    '',
    '---',
    '## [KPI 历次反思]（派发前自动注入）',
    '> 硬失败方向禁止重试；优先采纳换向建议。',
  ];
  for (const [i, r] of summaries.entries()) {
    lines.push(`\n### 反思 ${summaries.length - i}（${r.ts.slice(0, 16)}, verdict=${r.verdict}）`);
    if (r.hardFailures.length > 0) {
      lines.push('- **硬失败：** ' + r.hardFailures.join('；'));
    }
    if (r.softFailures.length > 0) {
      lines.push('- **软失败：** ' + r.softFailures.join('；'));
    }
    if (r.nextStrategy) {
      lines.push('- **换向：** ' + r.nextStrategy);
    }
  }
  return lines.join('\n');
}

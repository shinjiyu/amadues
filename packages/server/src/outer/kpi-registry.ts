/**
 * KpiRegistry — 长期 KPI 注册表
 *
 * KPI（Key Performance Indicator）= 给 agent 的一个长期目标，不像 inner-brain 任务那样
 * "一次 burst 跑完就归档"。一个 KPI 会跨越多个 burst：
 *   - burst 执行史由 kpiAdvancer 路径写入 burstRunHistory（onExit 不再 hook 评估）
 *   - 连续 N 个 burst idle 且无产出 → outcomeEvaluator 换 charter 续跑
 *   - KPI 本身只有 "active / paused / achieved / abandoned" 四个状态
 *
 * 数据持久化：<dataRoot>/kpi-registry.json（原子写）
 *
 * 这是 Tier 4 改造的核心抓手——DyFlow 内脑 / outcome 评估 / kpiAdvancer 都通过 kpiId
 * 关联同一组 burst 的"共享记忆"。
 *
 * ADL：doc/structurizr/KPI-BURST-OUTCOME-EVALUATOR.md
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type KpiStatus = 'active' | 'paused' | 'achieved' | 'abandoned';

/**
 * KPI 类型（ADL KPI-COMPLETION-JUDGE.md §3b）。
 *   - delivery：一次性交付目标，满足完成条件可 auto-achieve（默认）
 *   - ongoing：常驻 / 周期 / 监督类，**永不** auto-achieve，交付物只是节拍产出
 */
export type KpiKind = 'delivery' | 'ongoing';

/** @deprecated 调度已移除（定时由 burst AWAITING/wait_timer + changeWatcher）；保留 schema 读旧 JSON */
export type KpiCadence =
  | { type: 'once' }
  | { type: 'interval'; everyMs: number }
  | { type: 'cron'; hours: number[]; tz: string }
  | { type: 'continuous'; minGapMs: number };

/** 单轮 sprint 执行史（同一 canonical burst 内多轮） */
export type BurstRunExitStatus = 'DONE' | 'AWAITING' | 'ERROR' | 'PREEMPTED' | 'ABORTED';

/** KPI burst 外脑评估结果 — ADL KPI-BURST-OUTCOME-EVALUATOR.md §4 */
export interface BurstOutcomeEvaluation {
  evaluatedAt: string;
  successConfirmed: boolean;
  confidence: 'high' | 'medium' | 'low';
  failureReasons: string[];
  evidenceSummary: string;
  suggestedRetryCharter?: string;
  processReportDigest: string;
}

export interface BurstRunRecord {
  runId: string;
  instanceId: string;
  kpiId: string;
  startedAt: string;
  finishedAt: string;
  exitStatus: BurstRunExitStatus;
  charter: string;
  ticks: number;
  deliverableCount: number;
  outcomeEvaluation?: BurstOutcomeEvaluation;
}

/** momentum（多巴胺反馈调节）取值上下限；见 STRATEGY-PLANNING-LAYER.md §16 */
export const MOMENTUM_MIN = -5;
export const MOMENTUM_MAX = 5;

export interface KpiRecord {
  kpiId: string;
  /** 自然语言 KPI 描述（"通过 X 达成 Y"） */
  description: string;
  /** 谁创建（user_id 或 'agent:self' 表示 agent 自驱） */
  createdBy: string;
  createdAt: string;
  status: KpiStatus;
  /**
   * KPI 类型；默认 'delivery'。ongoing 类禁止 auto-achieve（见 KPI-COMPLETION-JUDGE.md §3b）。
   */
  kind: KpiKind;
  /**
   * 多巴胺反馈调节标量（STRATEGY-PLANNING-LAYER.md §16）：burst 有效推进 → 升，
   * idle/failed → 降，clamp 在 [MOMENTUM_MIN, MOMENTUM_MAX]。dispatcher 按它选 KPI。
   */
  momentum: number;
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
   * 会把这个值重置为 0；达阈值由 outcomeEvaluator 换 charter。
   */
  consecutiveIdleBursts: number;
  /** 用户可选填的附加约束 / 提示（自由文本，会拼进 burst 的 constraints） */
  notes?: string;
  /** 父 KPI id；子 KPI 首拆后设置 */
  parentKpiId?: string;
  /** 子 KPI id 列表（仅父节点） */
  children?: string[];
  /** 是否叶子（可 dispatch）；父 KPI 为 false */
  isLeaf: boolean;
  /** 外脑推进节拍 */
  cadence: KpiCadence;
  /** 下一发 sprint 章程（战略层 / 推进器） */
  charter?: string;
  /** cadence 计算的下次 due 时刻 */
  nextDueAt?: string;
  /** 本 leaf 复用的 canonical instanceId */
  /** @deprecated 扁平 KPI 多 burst；盘里 legacy 字段只读 */
  canonicalInstanceId?: string;
  /** 同一 burst 内多轮 sprint 执行史 */
  burstRunHistory: BurstRunRecord[];
}

export interface CreateKpiInput {
  description: string;
  createdBy: string;
  notes?: string;
  /** KPI 类型；默认 'delivery' */
  kind?: KpiKind;
  /**
   * KPI 类型；默认 'delivery'。
   * @deprecated asParent — 扁平 KPI 模型，create 始终 isLeaf: true
   */
  asParent?: boolean;
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
      for (const r of rows) {
        this.kpis.set(r.kpiId, this._normalize(r as unknown as Record<string, unknown>));
      }
    } catch {
      // 文件损坏时从空状态启动，旧文件留在原地供事后排查
    }
  }

  private static readonly _RECORD_KEYS: (keyof KpiRecord)[] = [
    'kpiId', 'description', 'createdBy', 'createdAt', 'status', 'kind', 'momentum',
    'finalizedAt', 'finalizedReason', 'bursts', 'lastBurstAt', 'consecutiveIdleBursts',
    'notes', 'parentKpiId', 'children', 'isLeaf', 'cadence', 'charter', 'nextDueAt',
    'canonicalInstanceId', 'burstRunHistory',
  ];

  /** 补默认字段；剥离盘里多出来的未知键 */
  private _normalize(raw: Record<string, unknown>): KpiRecord {
    const r = Object.fromEntries(
      KpiRegistry._RECORD_KEYS.filter((k) => k in raw).map((k) => [k, raw[k]]),
    ) as unknown as KpiRecord;
    const kind = r.kind ?? 'delivery';
    const isLeaf = r.isLeaf ?? (kind === 'delivery');
    return {
      ...r,
      kind,
      momentum: typeof r.momentum === 'number' ? r.momentum : 0,
      bursts: r.bursts ?? [],
      consecutiveIdleBursts: r.consecutiveIdleBursts ?? 0,
      isLeaf,
      children: r.children ?? [],
      cadence: r.cadence ?? { type: 'once' },
      burstRunHistory: r.burstRunHistory ?? [],
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

  /** 创建 KPI；status 默认 active（扁平 KPI，无子 KPI 首拆） */
  create(input: CreateKpiInput): KpiRecord {
    const kind = input.kind ?? 'delivery';
    const kpi: KpiRecord = {
      kpiId: this.generateKpiId(),
      description: input.description.trim(),
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
      status: 'active',
      kind,
      momentum: 0,
      bursts: [],
      consecutiveIdleBursts: 0,
      notes: input.notes?.trim() || undefined,
      isLeaf: true,
      cadence: { type: 'once' },
      burstRunHistory: [],
    };
    this.kpis.set(kpi.kpiId, kpi);
    this._save();
    return kpi;
  }

  /** 注册子 KPI 并挂到父节点 children */
  createChild(parentId: string, input: Omit<CreateKpiInput, 'asParent'> & {
    cadence: KpiCadence;
    charter?: string;
  }): KpiRecord | undefined {
    const parent = this.kpis.get(parentId);
    if (!parent) return undefined;
    const child: KpiRecord = {
      kpiId: this.generateKpiId(),
      description: input.description.trim(),
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
      status: 'active',
      kind: input.kind ?? parent.kind,
      momentum: 0,
      bursts: [],
      consecutiveIdleBursts: 0,
      notes: input.notes?.trim() || undefined,
      parentKpiId: parentId,
      isLeaf: true,
      cadence: input.cadence,
      charter: input.charter?.trim() || undefined,
      burstRunHistory: [],
    };
    this.kpis.set(child.kpiId, child);
    parent.children = [...(parent.children ?? []), child.kpiId];
    parent.isLeaf = false;
    this._save();
    return child;
  }

  /** 列出所有 active 叶子 KPI（dispatch 遍历对象） */
  listLeafKpis(filter?: { status?: KpiStatus }): KpiRecord[] {
    return this.list(filter).filter((k) => k.isLeaf);
  }

  appendBurstRun(kpiId: string, run: BurstRunRecord): void {
    const k = this.kpis.get(kpiId);
    if (!k) return;
    k.burstRunHistory.push(run);
    if (k.burstRunHistory.length > 200) {
      k.burstRunHistory = k.burstRunHistory.slice(-200);
    }
    this._save();
  }

  /** @deprecated 扁平 KPI 不再写 canonical */
  setCanonicalInstance(kpiId: string, instanceId: string): void {
    const k = this.kpis.get(kpiId);
    if (!k) return;
    k.canonicalInstanceId = instanceId;
    if (!k.bursts.includes(instanceId)) {
      k.bursts.push(instanceId);
    }
    this._save();
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
   * Caller 用返回值判断是否达到阈值需要 outcome 换向续跑。
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

  /**
   * 多巴胺反馈调节：按 delta 调整 momentum 并 clamp 在 [MOMENTUM_MIN, MOMENTUM_MAX]。
   * 返回更新后的 momentum；KPI 不存在或 delta 为 0 时不写盘。
   * 增量计算见 `kpi-feedback.ts`（纯函数，便于单测）。
   */
  adjustMomentum(kpiId: string, delta: number): number {
    const k = this.kpis.get(kpiId);
    if (!k) return 0;
    if (delta === 0) return k.momentum;
    const next = Math.max(MOMENTUM_MIN, Math.min(MOMENTUM_MAX, k.momentum + delta));
    if (next !== k.momentum) {
      k.momentum = next;
      this._save();
    }
    return k.momentum;
  }

  /** 主动放弃 KPI（用户或 agent 判定不可达） */
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

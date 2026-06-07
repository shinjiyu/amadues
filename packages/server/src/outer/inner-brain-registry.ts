/**
 * InnerBrainRegistry — 多内脑任务注册表
 *
 * 对应 openKuroneko 的 InnerBrainPool，但面向 utlraKuroneko 的嵌入式 Pi-mono 架构：
 *   - openKuroneko：管理子进程（ChildProcess）
 *   - utlraKuroneko：管理 workspace + in-process Pi-mono（每任务一个独立 workspace）
 *
 * 每个任务（instanceId）绑定一个独立 workspace，避免并发任务状态互相污染。
 * 注册表持久化到 <dataRoot>/inner-brain-registry.json，进程重启后历史可查。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveStoredWorkDir } from '../data-root.js';

export type TaskStatus = 'RUNNING' | 'BLOCKED' | 'AWAITING' | 'DONE' | 'STOPPED' | 'ERROR' | 'ABORTED';

/** ABORTED 来源：战略层显式 cull vs 静态超时兜底（见 STRATEGY-PLANNING-LAYER.md §9） */
export type AbortedBy = 'strategy_reflect' | 'stale_awaiting_timeout';

export interface TaskRecord {
  instanceId: string;
  /** utlra workspace ID，格式 task-<instanceId> */
  workspaceId: string;
  /** workspace 绝对路径 */
  workDir: string;
  goal: string;
  originUser: string;
  originThread?: string;
  status: TaskStatus;
  startedAt: string;
  finishedAt?: string;
  ticks?: number;
  /** 最后一次 tick 完成的时间（ISO 8601）。RUNNING 状态下可用于判断是否卡死 */
  lastTickAt?: string;
  /** 子进程 PID（仅 RUNNING 时有效；用于存活检测和 SIGTERM） */
  pid?: number;
  errorMessage?: string;
  /**
   * 进程重启被自动 resume 的累计次数。
   * 防止"任务陷入死循环 → server 重启 → 自动 resume → 再死循环 → 再重启"形成永动机。
   * 受 `UTLRA_INNER_MAX_AUTO_RESUME`（默认 3）限制；达到上限后不再自动 resume，用户可手动 restart。
   * 用户从 /api/inner-brains/:id/restart 手动 restart 时**不增加**这个计数（手动行为，无环境风险）。
   */
  resumeCount?: number;
  /**
   * 关联的 KPI ID（来自 KpiRegistry）。同一 KPI 的多个 burst 共享反思/失败记忆，
   * DyFlow 内脑通过 seed 读 drive9 / memory；KPI 上下文由外脑 charter 注入。
   * 不挂 KPI 的 burst（self-update / 一次性任务）此字段为空。
   */
  kpiId?: string;
  /**
   * 本 burst 产出的 deliverable 数量（register_deliverable 工具调用次数）。
   * Progress detector 用它判定 "idle 但有产出"（不计入 idle streak）vs "idle 且无产出"。
   */
  deliverableCount?: number;
  /**
   * 标记本任务是否为反思 burst（progress detector 自动派发的 meta 任务）。
   * 反思 burst 不计入 KPI 的 idleStreak，避免"反思失败 → 又触发反思"死循环。
   */
  /** @deprecated meta reflexion burst 已退役；新记录恒为 false */
  isReflexionBurst?: boolean;
  /** staleBurstReaper 写入：ABORTED 原因（cull reason / 'stale_awaiting_timeout'） */
  abortReason?: string;
  /** staleBurstReaper 写入：谁杀的 */
  abortedBy?: AbortedBy;
  /** staleBurstReaper 写入：ABORTED 时刻（ISO） */
  abortedAt?: string;
}

export class InnerBrainRegistry {
  private readonly registryPath: string;
  private readonly tasks: Map<string, TaskRecord> = new Map();

  constructor(private readonly dataRoot: string) {
    this.registryPath = path.join(dataRoot, 'inner-brain-registry.json');
    this._load();
  }

  private _load(): void {
    if (!fs.existsSync(this.registryPath)) return;
    try {
      const rows = JSON.parse(fs.readFileSync(this.registryPath, 'utf8')) as TaskRecord[];
      let migrated = false;
      for (const r of rows) {
        const workDir = resolveStoredWorkDir(r.workDir, this.dataRoot);
        if (workDir !== r.workDir) migrated = true;
        this.tasks.set(r.instanceId, { ...r, workDir });
      }
      if (migrated) this._save();
    } catch {
      // 文件损坏时忽略，从空状态启动
    }
  }

  private _save(): void {
    try {
      fs.mkdirSync(this.dataRoot, { recursive: true });
      fs.writeFileSync(
        this.registryPath,
        JSON.stringify(Array.from(this.tasks.values()), null, 2),
        'utf8',
      );
    } catch {
      // 写入失败不致命
    }
  }

  /** 生成唯一实例 ID（对齐 openKuroneko 格式：ib-<ts36>-<rand4>） */
  generateInstanceId(): string {
    const ts = Date.now().toString(36);
    const rand = crypto.randomBytes(2).toString('hex');
    return `ib-${ts}-${rand}`;
  }

  /** 注册新任务 */
  register(record: TaskRecord): void {
    this.tasks.set(record.instanceId, record);
    this._save();
  }

  /** 更新任务字段（部分更新） */
  update(instanceId: string, patch: Partial<TaskRecord>): void {
    const r = this.tasks.get(instanceId);
    if (!r) return;
    Object.assign(r, patch);
    this._save();
  }

  /** 查询单个任务 */
  get(instanceId: string): TaskRecord | undefined {
    return this.tasks.get(instanceId);
  }

  /** 返回所有任务，按启动时间降序 */
  list(): TaskRecord[] {
    return Array.from(this.tasks.values()).sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
  }

  /** 返回当前运行中的任务 */
  running(): TaskRecord[] {
    return this.list().filter((r) => r.status === 'RUNNING');
  }

  /** 返回处于 AWAITING 状态的任务（ChangeWatcher 用） */
  awaiting(): TaskRecord[] {
    return this.list().filter((r) => r.status === 'AWAITING');
  }

  /**
   * Server 启动时调用：将所有遗留的 RUNNING 任务标为 STOPPED 并返回它们。
   * 原因：内脑子进程是 agent 进程的子进程，agent 重启后这些子进程已被一起杀掉。
   *
   * 返回值用于自动 resume 流程（caller 决定是否对其中部分任务重新 spawn worker）。
   */
  markStaleRunningAsStopped(): TaskRecord[] {
    const now = new Date().toISOString();
    const stale: TaskRecord[] = [];
    for (const r of this.tasks.values()) {
      if (r.status === 'RUNNING') {
        r.status = 'STOPPED';
        r.finishedAt = now;
        r.errorMessage = '(server 重启，任务中断)';
        stale.push(r);
      }
    }
    if (stale.length > 0) this._save();
    return stale;
  }
}

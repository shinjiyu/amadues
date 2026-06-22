import fs from 'node:fs';
import path from 'node:path';
import { isDyflowWorkDir } from '../openkuroneko/inner-brain/dyflow-inspector.js';
import {
  projectDyflowStatus,
  projectDyflowStatusAfterAuto,
  readDyflowMode,
  seedDyflowBurstState,
} from '../openkuroneko/inner-brain/status-projection.js';
import type { RunManifest } from './manifest.js';
import { emptyManifest } from './manifest.js';
import { FilesystemWorkspaceStore } from './workspace-store.js';

export type InnerPhase = 'idle' | 'executing' | 'paused';
/** @deprecated 旧 status.json 可能仍含 planning；DyFlow 时代不再写入，读时按 executing 理解 */
export type LegacyInnerPhase = InnerPhase | 'planning';

/**
 * 内脑产物的 chat IR 资产视图（详见 doc/protocols/inner-brain-deliverables.md §4.2）。
 *
 * 由外脑 `onExit(DONE)` 分支在把 deliverables 转 asset 后回填到 `InnerBrainStatus`，
 * 供 LLM 通过 `read_inner_status` 看到可引用的 asset_id。
 */
export interface DeliverableAsset {
  /** 裸 UUID（不带 `asset:` 前缀）。Chat IR URI 时拼 `asset:${asset_id}` */
  asset_id: string;
  /** workspace 相对路径，仅供日志/调试 */
  source_path: string;
  /** 出站建议文件名（= path.basename(source_path)） */
  filename: string;
  mime: string;
  bytes: number;
  /** ISO 8601 with offset */
  registered_at: string;
  kind: 'image' | 'video' | 'audio' | 'file';
}

export interface InnerBrainStatus {
  schema: 'inner-status.v1';
  workspaceId: string;
  phase: InnerPhase;
  goalSummary: string;
  tickCount: number;
  lastAction: string | null;
  lastError: string | null;
  updatedAt: string;
  /**
   * 当前生命周期内已被吸收为 chat IR asset 的内脑产物。
   *
   * 详见 `doc/protocols/inner-brain-deliverables.md` §5：
   * - 由外脑 `onExit(DONE)` 调用 `setDeliverables` 写入。
   * - `setGoal` 重置内脑时清空（R5.2）。
   * - 视图层概念，asset 本身在 `ChatAssetStore` 不会被清。
   */
  deliverables: DeliverableAsset[];
}

const STATUS_FILE = path.join('.run', 'status.json');
const TELEMETRY_FILE = path.join('.run', 'telemetry', 'trace.jsonl');
/** openKuroneko / BrainFS 唯一权威目标（P3b：不再双写 .run/goal.md） */
const GOAL_FILE = path.join('.brain', 'goal.md');
/** 历史遗留路径，仅 readGoal 回退；setGoal 会删除以免漂移 */
const LEGACY_GOAL_FILE = path.join('.run', 'goal.md');

/** 与 openKuroneko BrainFS.defaultState 一致；仅 fullResetForRetest 等测试/遗留路径保留 */
const CONTROLLER_STATE_DECOMPOSE = JSON.stringify(
  {
    mode: 'DECOMPOSE',
    replanCount: 0,
    replanReason: null,
    blockedReason: null,
    sleepUntil: null,
    cycleCount: 0,
  },
  null,
  2,
);

export class InnerBrainEngine {
  private tickCount = 0;

  constructor(
    private readonly store: FilesystemWorkspaceStore,
    public readonly workspaceId: string,
  ) {
    this.store.ensureWorkspace(workspaceId);
    const st = this.readStatus();
    if (st) this.tickCount = st.tickCount;
  }

  private workDir(): string {
    return this.store.resolveWorkDir(this.workspaceId);
  }

  readStatus(): InnerBrainStatus | null {
    const raw = this.store.readTextFile(this.workspaceId, STATUS_FILE);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as InnerBrainStatus;
    } catch {
      return null;
    }
  }

  private writeStatus(partial: Partial<InnerBrainStatus> & Pick<InnerBrainStatus, 'phase'>): void {
    const prev = this.readStatus();
    const next: InnerBrainStatus = {
      schema: 'inner-status.v1',
      workspaceId: this.workspaceId,
      phase: partial.phase,
      goalSummary: partial.goalSummary ?? prev?.goalSummary ?? '',
      tickCount: partial.tickCount ?? prev?.tickCount ?? this.tickCount,
      lastAction: partial.lastAction ?? prev?.lastAction ?? null,
      lastError: partial.lastError !== undefined ? partial.lastError : prev?.lastError ?? null,
      updatedAt: new Date().toISOString(),
      deliverables: partial.deliverables ?? prev?.deliverables ?? [],
    };
    const wd = this.workDir();
    const p = path.join(wd, STATUS_FILE);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(next, null, 2), 'utf8');
  }

  /**
   * 写入本生命周期已吸收的产物资产列表（替换式，不增量合并）。
   *
   * 调用点：外脑 `onExit(DONE)` 分支，完成 deliverables → asset 转换后。
   * 详见 `doc/protocols/inner-brain-deliverables.md` §4.4 / §5。
   */
  setDeliverables(deliverables: DeliverableAsset[]): InnerBrainStatus {
    const prev = this.readStatus();
    this.writeStatus({
      phase: prev?.phase ?? 'idle',
      deliverables,
    });
    return this.readStatus()!;
  }

  setGoal(goalMarkdown: string): void {
    this.store.ensureWorkspace(this.workspaceId);
    const wd = this.workDir();
    const goalPath = path.join(wd, GOAL_FILE);
    fs.mkdirSync(path.dirname(goalPath), { recursive: true });
    fs.writeFileSync(goalPath, goalMarkdown, 'utf8');
    try {
      fs.unlinkSync(path.join(wd, LEGACY_GOAL_FILE));
    } catch {
      /* 旧 workspace 可能无 .run/goal.md */
    }

    // DyFlow 是唯一内脑引擎：seed DESIGN 态，不再写 legacy controller-state / planning 相位。
    seedDyflowBurstState(wd, this.workspaceId);

    this.tickCount = 0;
    projectDyflowStatus({
      workspaceId: this.workspaceId,
      workDir: wd,
      tickCount: 0,
      hadWork: false,
      dyflowMode: 'DESIGN',
      note: 'goal_set',
    });
    this.appendTelemetry({ event: 'goal_set', len: goalMarkdown.length, engine: 'dyflow' });
    this.touchManifestTelemetry();
  }

  readGoal(): string {
    const brain = this.store.readTextFile(this.workspaceId, GOAL_FILE);
    if (brain?.trim()) return brain;
    return this.store.readTextFile(this.workspaceId, LEGACY_GOAL_FILE) ?? '';
  }

  /**
   * 执行 openKuroneko Pi-mono 一次 tick 后调用：读 `.brain/controller-state.json`，同步 Dashboard 用 inner-status + 遥测。
   */
  syncAfterPiMonoTick(pi: { hadWork: boolean }): InnerBrainStatus {
    const wd = this.workDir();
    if (isDyflowWorkDir(wd)) {
      this.tickCount += 1;
      const projected = projectDyflowStatus({
        workspaceId: this.workspaceId,
        workDir: wd,
        tickCount: this.tickCount,
        hadWork: pi.hadWork,
        dyflowMode: readDyflowMode(wd),
        note: 'pi_mono_tick',
      });
      if (projected) {
        this.appendTelemetry({
          event: 'pi_mono_tick',
          hadWork: pi.hadWork,
          mode: readDyflowMode(wd),
          engine: 'dyflow',
        });
        this.touchManifestTelemetry();
        return projected;
      }
    }
    const raw = this.store.readTextFile(this.workspaceId, '.brain/controller-state.json');
    let mode = 'UNKNOWN';
    if (raw) {
      try {
        mode = (JSON.parse(raw) as { mode?: string }).mode ?? 'UNKNOWN';
      } catch {
        mode = 'parse_error';
      }
    }
    this.tickCount += 1;
    const phase = mapPiModeToInnerPhase(mode);
    this.writeStatus({
      phase,
      goalSummary: this.readGoal().slice(0, 200),
      tickCount: this.tickCount,
      lastAction: `pi_mono_tick hadWork=${pi.hadWork} mode=${mode}`,
      lastError: null,
    });
    this.appendTelemetry({
      event: 'pi_mono_tick',
      hadWork: pi.hadWork,
      mode,
    });
    this.touchManifestTelemetry();
    return this.readStatus()!;
  }

  /**
   * Pi-mono Auto（连续多轮 tick）结束后同步状态与一条汇总遥测。
   */
  syncAfterPiMonoAuto(pi: {
    ticks: number;
    lastHadWork: boolean;
    stoppedBy: 'idle' | 'max_ticks' | 'stop_signal';
  }): InnerBrainStatus {
    const wd = this.workDir();
    if (isDyflowWorkDir(wd)) {
      this.tickCount = Math.max(this.tickCount, pi.ticks);
      const projected = projectDyflowStatusAfterAuto(wd, this.workspaceId, pi);
      if (projected) {
        this.appendTelemetry({
          event: 'pi_mono_auto',
          ticks: pi.ticks,
          stoppedBy: pi.stoppedBy,
          lastHadWork: pi.lastHadWork,
          mode: readDyflowMode(wd),
          engine: 'dyflow',
        });
        this.touchManifestTelemetry();
        return projected;
      }
    }
    const raw = this.store.readTextFile(this.workspaceId, '.brain/controller-state.json');
    let mode = 'UNKNOWN';
    if (raw) {
      try {
        mode = (JSON.parse(raw) as { mode?: string }).mode ?? 'UNKNOWN';
      } catch {
        mode = 'parse_error';
      }
    }
    this.tickCount += Math.max(0, pi.ticks);
    const phase = mapPiModeToInnerPhase(mode);
    this.writeStatus({
      phase,
      goalSummary: this.readGoal().slice(0, 200),
      tickCount: this.tickCount,
      lastAction: `pi_mono_auto ticks=${pi.ticks} stoppedBy=${pi.stoppedBy} lastHadWork=${pi.lastHadWork} mode=${mode}`,
      lastError: null,
    });
    this.appendTelemetry({
      event: 'pi_mono_auto',
      ticks: pi.ticks,
      stoppedBy: pi.stoppedBy,
      lastHadWork: pi.lastHadWork,
      mode,
    });
    this.touchManifestTelemetry();
    return this.readStatus()!;
  }

  /**
   * 记录一次 LLM 回合（遥测 + 状态 + 可选落盘全文，便于 UI/排障）。
   */
  noteLlmRound(input: {
    assistantText: string;
    model: string;
    usedVision: boolean;
    visionModel?: string;
    userHint?: string;
  }): InnerBrainStatus {
    this.tickCount += 1;
    const preview = input.assistantText.slice(0, 120).replace(/\s+/g, ' ');
    this.writeStatus({
      phase: 'executing',
      goalSummary: this.readGoal().slice(0, 200),
      tickCount: this.tickCount,
      lastAction: `llm:${input.model}${input.usedVision ? '+vision' : ''} ${preview}`,
      lastError: null,
    });
    const wd = this.workDir();
    const lastPath = path.join(wd, '.run', 'llm-last.md');
    fs.mkdirSync(path.dirname(lastPath), { recursive: true });
    fs.writeFileSync(
      lastPath,
      `# LLM last output\n\n_model: ${input.model}\n_vision: ${input.usedVision}${input.visionModel ? ` (${input.visionModel})` : ''}\n\n${input.assistantText}`,
      'utf8',
    );
    this.appendTelemetry({
      event: 'llm_round',
      tickCount: this.tickCount,
      model: input.model,
      usedVision: input.usedVision,
      visionModel: input.visionModel,
      preview,
      userHint: input.userHint?.slice(0, 200),
    });
    this.touchManifestTelemetry();
    return this.readStatus()!;
  }

  noteLlmError(message: string): InnerBrainStatus {
    this.writeStatus({
      phase: 'paused',
      goalSummary: this.readGoal().slice(0, 200),
      tickCount: this.tickCount,
      lastAction: 'llm_error',
      lastError: message.slice(0, 500),
    });
    this.appendTelemetry({ event: 'llm_error', error: message.slice(0, 500) });
    this.touchManifestTelemetry();
    return this.readStatus()!;
  }

  /**
   * 外显「关闭内脑」：将 Pi-mono 控制器置为 SLEEPING（远期唤醒），并清理 execution-context。
   * 与「重置」不同：不删除 goal，仅让 tick 在无外脑输入时长期休眠。
   */
  brainShutdown(): InnerBrainStatus {
    this.store.ensureWorkspace(this.workspaceId);
    const wd = this.workDir();
    const statePath = path.join(wd, '.brain', 'controller-state.json');
    let prev: Record<string, unknown> = {};
    try {
      if (fs.existsSync(statePath)) {
        prev = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
      }
    } catch {
      prev = {};
    }
    const next: Record<string, unknown> = {
      mode: 'SLEEPING',
      replanCount: typeof prev['replanCount'] === 'number' ? prev['replanCount'] : 0,
      replanReason: null,
      blockedReason: null,
      sleepUntil: '2099-12-31T23:59:59.999Z',
    };
    if (typeof prev['cycleCount'] === 'number') next['cycleCount'] = prev['cycleCount'];
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(next, null, 2), 'utf8');
    try {
      fs.unlinkSync(path.join(wd, '.brain', 'execution-context.json'));
    } catch {
      /* */
    }
    this.writeStatus({
      phase: 'idle',
      goalSummary: this.readGoal().slice(0, 200),
      tickCount: this.tickCount,
      lastAction: 'brain_shutdown',
      lastError: null,
    });
    this.appendTelemetry({ event: 'brain_shutdown' });
    this.touchManifestTelemetry();
    return this.readStatus()!;
  }

  /**
   * 清空 .brain 下的知识库：knowledge.md、skills.md 及 skills/*.md（置空，保留路径）。
   */
  clearKnowledgeFiles(): { status: InnerBrainStatus; cleared: string[] } {
    this.store.ensureWorkspace(this.workspaceId);
    const wd = this.workDir();
    const brain = path.join(wd, '.brain');
    fs.mkdirSync(brain, { recursive: true });
    const cleared: string[] = [];
    for (const f of ['knowledge.md', 'skills.md'] as const) {
      const p = path.join(brain, f);
      fs.writeFileSync(p, '', 'utf8');
      cleared.push(`.brain/${f}`);
    }
    const skillsDir = path.join(brain, 'skills');
    if (fs.existsSync(skillsDir)) {
      for (const name of fs.readdirSync(skillsDir)) {
        if (!name.endsWith('.md')) continue;
        const fp = path.join(skillsDir, name);
        try {
          if (fs.statSync(fp).isFile()) {
            fs.writeFileSync(fp, '', 'utf8');
            cleared.push(`.brain/skills/${name}`);
          }
        } catch {
          /* */
        }
      }
    }
    const prev = this.readStatus();
    this.writeStatus({
      phase: prev?.phase ?? 'idle',
      goalSummary: this.readGoal().slice(0, 200),
      tickCount: this.tickCount,
      lastAction: 'clear_knowledge',
      lastError: null,
    });
    this.appendTelemetry({ event: 'clear_knowledge', clearedCount: cleared.length });
    this.touchManifestTelemetry();
    return { status: this.readStatus()!, cleared };
  }

  /**
   * 完全清空 workspace 内脑相关状态，便于从零重新跑 Pi-mono：
   * Goal、.brain 核心 Markdown、controller-state→DECOMPOSE、skills、history、.run/pi-mono、遥测与 manifest 等。
   * 不删除 workspace 根目录交付物（如 *.md 报告）与 .tool-outputs。
   */
  fullResetForRetest(): InnerBrainStatus {
    this.store.ensureWorkspace(this.workspaceId);
    this.tickCount = 0;
    const wd = this.workDir();
    const brain = path.join(wd, '.brain');
    fs.mkdirSync(brain, { recursive: true });

    for (const rel of [GOAL_FILE, LEGACY_GOAL_FILE] as const) {
      try {
        fs.unlinkSync(path.join(wd, rel));
      } catch {
        /* */
      }
    }

    for (const f of ['milestones.md', 'constraints.md', 'knowledge.md', 'skills.md', 'environment.md'] as const) {
      fs.writeFileSync(path.join(brain, f), '', 'utf8');
    }
    fs.writeFileSync(path.join(brain, 'controller-state.json'), CONTROLLER_STATE_DECOMPOSE, 'utf8');
    try {
      fs.unlinkSync(path.join(brain, 'execution-context.json'));
    } catch {
      /* */
    }

    const skillsDir = path.join(brain, 'skills');
    if (fs.existsSync(skillsDir)) {
      for (const name of fs.readdirSync(skillsDir)) {
        if (!name.endsWith('.md')) continue;
        const fp = path.join(skillsDir, name);
        try {
          if (fs.statSync(fp).isFile()) fs.writeFileSync(fp, '', 'utf8');
        } catch {
          /* */
        }
      }
    }

    const historyDir = path.join(brain, 'history');
    try {
      if (fs.existsSync(historyDir)) fs.rmSync(historyDir, { recursive: true, force: true });
    } catch {
      /* */
    }

    const piMonoDir = path.join(wd, '.run', 'pi-mono');
    try {
      if (fs.existsSync(piMonoDir)) fs.rmSync(piMonoDir, { recursive: true, force: true });
    } catch {
      /* */
    }

    try {
      fs.unlinkSync(path.join(wd, '.run', 'llm-last.md'));
    } catch {
      /* */
    }

    try {
      fs.unlinkSync(path.join(wd, TELEMETRY_FILE));
    } catch {
      /* */
    }

    this.store.writeManifest(this.workspaceId, emptyManifest(this.workspaceId, wd));

    this.writeStatus({
      phase: 'idle',
      goalSummary: '',
      tickCount: 0,
      lastAction: 'full_reset',
      lastError: null,
      deliverables: [],
    });
    this.appendTelemetry({ event: 'full_reset' });
    this.touchManifestTelemetry();
    return this.readStatus()!;
  }

  /** 与 {@link fullResetForRetest} 相同，保留短名供内部/脚本调用。 */
  reset(): void {
    this.fullResetForRetest();
  }

  private appendTelemetry(entry: Record<string, unknown>): void {
    const wd = this.workDir();
    const p = path.join(wd, TELEMETRY_FILE);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(p, line, 'utf8');
  }

  private touchManifestTelemetry(): void {
    const m = this.store.readManifest(this.workspaceId);
    const traceRel = '.run/telemetry/trace.jsonl';
    const next: RunManifest = {
      ...m,
      outcomes: {
        ...m.outcomes,
        telemetry: { tracePath: traceRel },
      },
    };
    this.store.writeManifest(this.workspaceId, next);
  }

  readTelemetryTail(maxLines = 50): string[] {
    const raw = this.store.readTextFile(this.workspaceId, TELEMETRY_FILE);
    if (!raw) return [];
    return raw.trim().split('\n').filter(Boolean).slice(-maxLines);
  }
}

function mapPiModeToInnerPhase(mode: string): InnerPhase {
  switch (mode) {
    case 'DECOMPOSE':
    case 'EXECUTE':
    case 'ATTRIBUTE':
      return 'executing';
    case 'BLOCKED':
      return 'paused';
    case 'SLEEPING':
      return 'idle';
    default:
      return 'executing';
  }
}

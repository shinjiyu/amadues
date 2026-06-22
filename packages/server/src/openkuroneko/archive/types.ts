/**
 * Knowledge Archive — 公共类型与 KnowledgeStore 接口
 *
 * 接口优先设计：Controller / Decomposer 只依赖此接口，
 * 底层实现（FilesystemStore / Mem0Store / HybridStore）可无缝替换。
 */

import type { BrainFS } from '../brain/index.js';

// ── 数据类型 ──────────────────────────────────────────────────────────────────

/** 归档触发原因 */
export type ArchiveTrigger = 'COMPLETE' | 'BLOCK' | 'REPLAN_LIMIT' | 'CYCLE_MAX';

/** burst 结束时的结构化结果摘要（写入 session meta） */
export interface BurstOutcomeArchive {
  verdict: 'success' | 'partial' | 'failed';
  hardFailures: string[];
  softFailures: string[];
  nextStrategy: string;
}

/** 单个归档 session 的元数据 */
export interface SessionMeta {
  sessionId: string;
  agentId: string;
  workDir: string;
  ts: string;
  trigger: ArchiveTrigger;
  triggerReason: string;
  goalSummary: string;
  goalKeywords: string[];
  /** 关联的 KPI ID（可选，同 KPI 多 burst 共享反思记忆） */
  kpiId?: string;
  /** burst 结束判定：success / partial / failed */
  verdict?: 'success' | 'partial' | 'failed';
  /** burst 结果摘要（仅 meta.json） */
  burstOutcome?: BurstOutcomeArchive;
  counts: {
    constraints: number;
    skills: number;
    knowledge: number;
  };
}

/** 检索到的 session（含截断后的内容） */
export interface RetrievedSession {
  meta: SessionMeta;
  score: number;
  constraints: string;
  skills: string;
  knowledge: string;
}

/** 检索选项 */
export interface RetrieveOptions {
  /** 最多返回几个 session，默认 3 */
  maxSessions?: number;
  /** constraints 的最低相关度阈值，默认 0.1（宽松，近乎通用） */
  constraintThreshold?: number;
  /** skills 的最低相关度阈值，默认 0.2 */
  skillThreshold?: number;
  /** knowledge 的最低相关度阈值，默认 0.4（严格，环境特定） */
  knowledgeThreshold?: number;
  /** 同 KPI 的 session 优先返回 */
  kpiId?: string;
  /** 每类内容的最大字符数，默认 800 */
  maxCharsPerType?: number;
}

// ── 核心接口 ──────────────────────────────────────────────────────────────────

export interface KnowledgeStore {
  /**
   * 将当前 .brain/ 的三类产出（constraints / skills / knowledge）归档到知识库。
   * 在 agent 生命周期结束时（COMPLETE / BLOCK / REPLAN_LIMIT）调用。
   * 并发安全：不同 agent 同时调用互不干扰。
   */
  archive(params: {
    brain: BrainFS;
    agentId: string;
    workDir: string;
    trigger: ArchiveTrigger;
    triggerReason: string;
    goalText: string;
    /** 关联的 KPI ID（可选，同 KPI 多 burst 共享反思记忆） */
    kpiId?: string;
    /** burst 结果摘要（可选） */
    burstOutcome?: BurstOutcomeArchive;
  }): Promise<void>;

  /**
   * 按 goal 文本检索与当前任务相关的历史 session。
   * 返回按相关度降序排列的 RetrievedSession 列表。
   */
  retrieve(goalText: string, opts?: RetrieveOptions): Promise<RetrievedSession[]>;

  /**
   * 将检索结果转换为可注入 Decomposer user message 的 Markdown 片段。
   * 若无相关 session，返回空字符串。
   */
  buildContext(sessions: RetrievedSession[]): string;
}

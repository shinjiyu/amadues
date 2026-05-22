/**
 * BrainFS — 管理 .brain/ 目录下的所有持久化文件
 *
 * 文件即真相（File-as-State）：内脑所有认知状态均存储于此。
 * 目录结构（均在 workDir/.brain/ 下）：
 *   goal.md              - 战略目标（外脑写）
 *   milestones.md        - 战术里程碑（Decomposer 写）
 *   constraints.md       - 归因红线（Attributor 追加）
 *   knowledge.md         - 环境事实（Attributor 追加）
 *   skills.md            - 可复用技能（Attributor 追加）
 *   environment.md       - 当前环境快照（框架更新）
 *   controller-state.json - 控制器状态机（框架读写）
 *   execution-context.json - EXECUTE→ATTRIBUTE 的临时传递（框架读写）
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { createGitStore, type GitStore, type CommitMeta } from './git-store.js';
import {
  type PendingItem,
  readPendings as readPendingsRaw,
  writePendings as writePendingsRaw,
  addPending as addPendingRaw,
  resolvePending as resolvePendingRaw,
  markConsumed as markConsumedRaw,
  listActivePendings as listActivePendingsRaw,
  listUnconsumedResolved as listUnconsumedResolvedRaw,
  findByCtxRef as findByCtxRefRaw,
  expireOverduePendings as expireOverdueRaw,
  resolveDueTimers as resolveDueTimersRaw,
  nextDeadlineMs as nextDeadlineMsRaw,
  type AddPendingInput,
  type ResolveInput,
} from '../pendings/index.js';

// ── 里程碑解析 ────────────────────────────────────────────────────────────────

export interface Milestone {
  id: string;                            // e.g. "M1"
  status: 'Active' | 'Pending' | 'Completed';
  title: string;
  description: string;
  /** 循环里程碑：每次 CYCLE_DONE 后等待该时长（ms）再重新执行 */
  cyclic?: boolean;
  cycleIntervalMs?: number;
  /**
   * 战术拆解器在里程碑标题行下用 `> 标签：内容` 写入的约定（可多行累加同标签）。
   * 供 Executor / Attributor 注入上下文，约束输入范围与交付物，减少局部过度求解。
   */
  dependsOn?: string;
  inputsScope?: string;
  outputsContract?: string;
  operationsAvoid?: string;
}

// ── 控制器状态 ────────────────────────────────────────────────────────────────

export type ControllerMode =
  | 'DECOMPOSE'
  | 'EXECUTE'
  | 'ATTRIBUTE'
  | 'BLOCKED'   // 兼容旧路径；新代码统一走 AWAITING
  | 'SLEEPING'  // 兼容旧路径；新代码统一走 AWAITING
  | 'AWAITING'; // 统一异步等待（pending 数据驱动）

export interface ControllerState {
  mode: ControllerMode;
  replanCount: number;
  replanReason: string | null;
  blockedReason: string | null;
  /** SLEEPING 模式：唤醒时间（ISO 8601）。AWAITING 模式不再使用此字段 */
  sleepUntil?: string | null;
  /** 当前循环里程碑已完成的循环次数 */
  cycleCount?: number;
  /** AWAITING 模式：等待原因的人类可读摘要（来自最近一次进入 AWAITING） */
  awaitingReason?: string | null;
}

// ── 执行上下文（EXECUTE → ATTRIBUTE 传递） ───────────────────────────────────

export interface ExecutionEntry {
  toolName: string;
  args: Record<string, unknown>;
  result: { ok: boolean; output: string };
  error?: string;
}

export interface ExecutionContext {
  activeMilestone: Milestone;
  preState: string;
  executionLog: ExecutionEntry[];
  postState: string;
}

// ── 技能库类型 ────────────────────────────────────────────────────────────────

/**
 * 技能目录索引条目（对应 skills.md 每一行，TSV 格式）
 *   id \t category \t title \t tags \t ts
 */
export interface SkillEntry {
  id: string;          // e.g. "s-0001"
  category: string;   // e.g. "browser" | "web" | "file" | "shell" | "general"
  title: string;      // 一句话标题
  tags: string[];     // 关键词标签（用于动态匹配）
  ts: string;         // ISO timestamp
}

// ── BrainFS 类 ────────────────────────────────────────────────────────────────

export class BrainFS {
  readonly brainDir: string;
  readonly workDir: string;
  readonly git: GitStore;

  constructor(workDir: string) {
    this.workDir = workDir;
    this.brainDir = path.join(workDir, '.brain');
    fs.mkdirSync(this.brainDir, { recursive: true });
    this.git = createGitStore(workDir);
  }

  /**
   * 提交一次 git commit（异步 fire-and-forget；失败不影响主流程）。
   * Controller 在每次 writeState 之后调用，承担"数据演化即历史"的写盘协议。
   */
  commit(message: string, meta?: CommitMeta): Promise<string | null> {
    if (!this.git.enabled) return Promise.resolve(null);
    return this.git.commit(message, meta);
  }

  // ── 基础 I/O ────────────────────────────────────────────────────────────────

  private p(name: string): string {
    return path.join(this.brainDir, name);
  }

  private read(name: string): string {
    const fp = this.p(name);
    return fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : '';
  }

  private write(name: string, content: string): void {
    fs.writeFileSync(this.p(name), content, 'utf8');
  }

  private append(name: string, content: string): void {
    const fp = this.p(name);
    if (!fs.existsSync(fp)) {
      fs.writeFileSync(fp, content + '\n', 'utf8');
    } else {
      fs.appendFileSync(fp, '\n' + content + '\n', 'utf8');
    }
  }

  // ── 六大文件 ────────────────────────────────────────────────────────────────

  readGoal(): string      { return this.read('goal.md'); }
  writeGoal(c: string)    { this.write('goal.md', c); }

  /**
   * 读取发起当前目标的用户 ID（由外脑 set_goal 工具写入 goal.md 头部）。
   * 格式：第一行 "origin_user: <userId>" 后跟空行和目标内容。
   * 未找到返回 null。
   */
  readGoalOriginUser(): string | null {
    const goal = this.readGoal();
    const match = goal.match(/^origin_user:\s*(\S+)/m);
    return match ? (match[1] ?? null) : null;
  }

  /**
   * 读取发起当前目标时所在的 thread_id（群聊任务通知回落用）。
   * 格式：goal.md 头部 "origin_thread: <thread_id>"。
   * 未找到返回 null。
   */
  readGoalOriginThread(): string | null {
    const goal = this.readGoal();
    const match = goal.match(/^origin_thread:\s*(\S+)/m);
    return match ? (match[1] ?? null) : null;
  }

  readMilestones(): string       { return this.read('milestones.md'); }
  writeMilestones(c: string)     { this.write('milestones.md', c); }

  readConstraints(): string      { return this.read('constraints.md'); }
  appendConstraint(c: string)    { this.append('constraints.md', c); }

  readKnowledge(): string        { return this.read('knowledge.md'); }
  appendKnowledge(c: string)     { this.append('knowledge.md', c); }

  /** @deprecated 旧接口，仅用于兼容迁移脚本 */
  readSkills(): string           { return this.read('skills.md'); }
  /** @deprecated 旧接口，请改用 writeSkill() */
  appendSkill(c: string)         { this.append('skills.md', c); }

  // ── 技能库（分类目录 + 独立文件 + 动态发现） ──────────────────────────────

  /**
   * 生成技能 ID：取标题前几个词转 slug + 短 hash 后缀防冲突。
   * 例：「用 Playwright 登录微博并保存 cookies」→「playwright-weibo-cookies-a3f2」
   */
  private newSkillId(title = ''): string {
    const slug = title
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5\s-]/g, '')   // 保留字母数字中文空格连字符
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 4)                               // 取前 4 个词
      .join('-')
      .replace(/[\u4e00-\u9fa5]+/g, '')         // 去掉中文（保留英文词）
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32);
    const suffix = crypto.randomBytes(2).toString('hex');
    return slug ? `${slug}-${suffix}` : `skill-${suffix}`;
  }

  /** 读取技能目录索引（skills.md，TSV 格式） */
  readSkillIndex(): SkillEntry[] {
    const raw = this.read('skills.md');
    if (!raw.trim()) return [];
    return raw.split('\n')
      .filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('//'))
      .map(l => {
        const [id, category, title, tagsStr, ts] = l.split('\t');
        if (!id || !category || !title) return null;
        return {
          id: id.trim(),
          category: category.trim(),
          title: title.trim(),
          tags: (tagsStr ?? '').split(',').map(t => t.trim()).filter(Boolean),
          ts: (ts ?? '').trim(),
        } as SkillEntry;
      })
      .filter((e): e is SkillEntry => e !== null);
  }

  /**
   * 查找与给定 title+tags 高度相似的已有技能。
   * 相似度 = 共同词 / max(两集合大小)，超过 DEDUP_THRESHOLD 视为重复。
   */
  findSimilarSkill(
    title: string,
    tags: string[],
    category: string,
    threshold = 0.55,
  ): SkillEntry | null {
    const index = this.readSkillIndex();
    const newWords = new Set([
      ...tokenize(title),
      ...tags.flatMap(t => tokenize(t)),
    ]);
    if (newWords.size === 0) return null;

    let best: SkillEntry | null = null;
    let bestSim = 0;

    for (const entry of index) {
      // 同分类优先（跨分类相似度要求更高）
      const catBonus = entry.category === category ? 0 : 0.15;
      const entryWords = new Set([
        ...tokenize(entry.title),
        ...entry.tags.flatMap(t => tokenize(t)),
      ]);
      let shared = 0;
      for (const w of newWords) {
        if (entryWords.has(w)) shared++;
      }
      const sim = shared / Math.max(newWords.size, entryWords.size) - catBonus;
      if (sim > bestSim) { bestSim = sim; best = entry; }
    }

    return bestSim >= threshold ? best : null;
  }

  /**
   * 更新已有技能文件内容，同时刷新索引行的 tags 和 ts。
   */
  updateSkill(entry: SkillEntry, newContent: string, newTags: string[]): void {
    const ts = new Date().toISOString();
    const skillFile = path.join(this.brainDir, 'skills', entry.category, `${entry.id}.md`);

    // 追加新版本内容到文件末尾（保留历史，可回溯）
    const appendBlock = `\n\n---\n> 更新 ${ts}\n\n${newContent}\n`;
    if (fs.existsSync(skillFile)) {
      fs.appendFileSync(skillFile, appendBlock, 'utf8');
    } else {
      fs.mkdirSync(path.dirname(skillFile), { recursive: true });
      fs.writeFileSync(skillFile, `# ${entry.title}\n\n> category: ${entry.category} | id: ${entry.id}\n${newContent}\n`, 'utf8');
    }

    // 更新索引行：替换旧行的 tags 和 ts
    const indexPath = this.p('skills.md');
    if (!fs.existsSync(indexPath)) return;
    const lines = fs.readFileSync(indexPath, 'utf8').split('\n');
    const mergedTags = [...new Set([...entry.tags, ...newTags])].join(',');
    const updated = lines.map(l => {
      const cols = l.split('\t');
      if (cols[0] === entry.id) {
        return [entry.id, entry.category, entry.title, mergedTags, ts].join('\t');
      }
      return l;
    });
    fs.writeFileSync(indexPath, updated.join('\n'), 'utf8');
  }

  /**
   * 写入一条技能（含去重逻辑）：
   *   - 若已存在高度相似技能（相似度 ≥ 阈值）→ 追加更新到现有文件
   *   - 否则新建 .brain/skills/<category>/<id>.md 并追加索引行
   *
   * 返回 { id, action: 'created' | 'merged' }
   */
  writeSkill(params: {
    category: string;
    title: string;
    tags: string[];
    content: string;
  }): { id: string; action: 'created' | 'merged' } {
    const { category, title, tags, content } = params;
    const safeCategory = category.replace(/[^a-z0-9_-]/gi, '_').toLowerCase() || 'general';

    // ── 去重检查 ─────────────────────────────────────────────────────────────
    const similar = this.findSimilarSkill(title, tags, safeCategory);
    if (similar) {
      this.updateSkill(similar, content, tags);
      return { id: similar.id, action: 'merged' };
    }

    // ── 新建技能 ─────────────────────────────────────────────────────────────
    const id = this.newSkillId(title);
    const ts = new Date().toISOString();

    const skillsDir = path.join(this.brainDir, 'skills', safeCategory);
    fs.mkdirSync(skillsDir, { recursive: true });
    const skillFile = path.join(skillsDir, `${id}.md`);
    fs.writeFileSync(skillFile,
      `# ${title}\n\n> category: ${safeCategory} | id: ${id} | ${ts}\n\n${content}\n`,
      'utf8',
    );

    const indexLine = [id, safeCategory, title, tags.join(','), ts].join('\t');
    const indexPath = this.p('skills.md');
    if (!fs.existsSync(indexPath)) {
      fs.writeFileSync(indexPath, '# skills index: id\tcategory\ttitle\ttags\tts\n', 'utf8');
    }
    fs.appendFileSync(indexPath, indexLine + '\n', 'utf8');

    return { id, action: 'created' };
  }

  /**
   * 动态技能发现：用 query 文本做关键词匹配，返回 top-K 最相关的技能条目。
   * 算法：对索引每条计算 title+tags 与 query 词的重叠分，取最高 K 条。
   */
  searchSkills(query: string, topK = 3): SkillEntry[] {
    const index = this.readSkillIndex();
    if (index.length === 0) return [];

    const queryWords = tokenize(query);
    if (queryWords.size === 0) return index.slice(0, topK);

    const scored = index.map(entry => {
      const entryWords = new Set([
        ...tokenize(entry.title),
        ...entry.tags.flatMap(t => tokenize(t)),
        ...tokenize(entry.category),
      ]);
      let score = 0;
      for (const w of queryWords) {
        if (entryWords.has(w)) score++;
      }
      return { entry, score };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(s => s.entry);
  }

  /**
   * 读取多个技能条目的完整文件内容，返回拼接字符串。
   */
  readSkillFiles(entries: SkillEntry[]): string {
    const parts: string[] = [];
    for (const entry of entries) {
      const fp = path.join(this.brainDir, 'skills', entry.category, `${entry.id}.md`);
      if (fs.existsSync(fp)) {
        parts.push(fs.readFileSync(fp, 'utf8').trim());
      }
    }
    return parts.join('\n\n---\n\n');
  }

  readEnvironment(): string      { return this.read('environment.md'); }
  writeEnvironment(c: string)    { this.write('environment.md', c); }

  // ── 控制器状态 ───────────────────────────────────────────────────────────────

  readState(): ControllerState {
    try {
      const raw = this.read('controller-state.json');
      if (!raw.trim()) return defaultState();
      return JSON.parse(raw) as ControllerState;
    } catch {
      return defaultState();
    }
  }

  writeState(state: ControllerState): void {
    this.write('controller-state.json', JSON.stringify(state, null, 2));
  }

  // ── Pendings 代理（数据本体的一部分） ────────────────────────────────────

  readPendings(): PendingItem[] {
    return readPendingsRaw(this.brainDir);
  }

  writePendings(items: PendingItem[]): void {
    writePendingsRaw(this.brainDir, items);
  }

  addPending(input: AddPendingInput): PendingItem {
    return addPendingRaw(this.brainDir, input);
  }

  resolvePending(id: string, input: ResolveInput = {}): PendingItem | null {
    return resolvePendingRaw(this.brainDir, id, input);
  }

  markPendingsConsumed(ids: string[]): void {
    markConsumedRaw(this.brainDir, ids);
  }

  listActivePendings(): PendingItem[] {
    return listActivePendingsRaw(this.brainDir);
  }

  listUnconsumedResolvedPendings(): PendingItem[] {
    return listUnconsumedResolvedRaw(this.brainDir);
  }

  findPendingByCtxRef(ctxRef: string): PendingItem | null {
    return findByCtxRefRaw(this.brainDir, ctxRef);
  }

  expireOverduePendings(now = Date.now()): string[] {
    return expireOverdueRaw(this.brainDir, now);
  }

  resolveDueTimers(now = Date.now()): string[] {
    return resolveDueTimersRaw(this.brainDir, now);
  }

  nextPendingDeadlineMs(now = Date.now()): number | null {
    return nextDeadlineMsRaw(this.brainDir, now);
  }

  // ── 执行上下文（临时，Attributor 读完即删） ────────────────────────────────

  hasExecutionContext(): boolean {
    return fs.existsSync(this.p('execution-context.json'));
  }

  readExecutionContext(): ExecutionContext | null {
    try {
      const raw = this.read('execution-context.json');
      if (!raw.trim()) return null;
      return JSON.parse(raw) as ExecutionContext;
    } catch {
      return null;
    }
  }

  writeExecutionContext(ctx: ExecutionContext): void {
    this.write('execution-context.json', JSON.stringify(ctx, null, 2));
  }

  clearExecutionContext(): void {
    const fp = this.p('execution-context.json');
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }

  // ── 里程碑解析 ───────────────────────────────────────────────────────────────

  parseMilestones(warnOnFail?: (line: string) => void): Milestone[] {
    const content = this.readMilestones();
    return parseMilestonesFromContent(content, warnOnFail);
  }

  getActiveMilestone(warnOnFail?: (line: string) => void): Milestone | null {
    return this.parseMilestones(warnOnFail).find(m => m.status === 'Active') ?? null;
  }

  markMilestoneCompleted(id: string): void {
    const content = this.readMilestones();
    // Replace [M1] [Active] → [M1] [Completed]
    const updated = content.replace(
      new RegExp(`(\\[${id}\\]\\s+)\\[Active\\]`, 'g'),
      `$1[Completed]`
    );
    this.writeMilestones(updated);
  }

  activateNextPending(): boolean {
    const milestones = this.parseMilestones();
    const next = milestones.find(m => m.status === 'Pending');
    if (!next) return false;
    const content = this.readMilestones();
    const updated = content.replace(
      new RegExp(`(\\[${next.id}\\]\\s+)\\[Pending\\]`),
      `$1[Active]  `
    );
    this.writeMilestones(updated);
    return true;
  }

  allMilestonesCompleted(): boolean {
    const milestones = this.parseMilestones();
    return milestones.length > 0 && milestones.every(m => m.status === 'Completed');
  }

  /**
   * 循环里程碑：本轮结束后不标记 Completed，只是准备下一轮。
   * 里程碑状态保持 Active，Controller 进入 SLEEPING 等待。
   * （普通里程碑请用 markMilestoneCompleted）
   */
  keepCyclicMilestoneActive(_id: string): void {
    // 里程碑状态不变（仍为 Active），无需修改 milestones.md
    // 此方法作为语义占位，Controller 调用它表明这是循环里程碑逻辑
  }

  // ── goal.md 中读取 max_replan / max_cycles 参数 ─────────────────────────────

  parseMaxReplan(): number {
    const goal = this.readGoal();
    const m = goal.match(/max_replan\s*[=:]\s*(\d+)/i);
    return m && m[1] ? parseInt(m[1], 10) : 5;
  }

  /**
   * 从 goal.md 中读取 max_cycles 参数（循环里程碑轮次上限）。
   * 返回 0 表示不限制（默认）。
   * 示例：在 goal.md 末尾写 `max_cycles: 30`
   */
  parseMaxCycles(): number {
    const goal = this.readGoal();
    const m = goal.match(/max_cycles\s*[=:]\s*(\d+)/i);
    return m && m[1] ? parseInt(m[1], 10) : 0;
  }

  // ── 新任务归档（清理旧任务的 brain 状态，保留 skills 知识沉淀） ───────────────

  /**
   * 将当前任务的 brain 文件归档到 history/<timestamp>/，然后清空，
   * 使下一个任务从干净状态开始。skills.md 保留（含跨任务的通用操作模式）。
   */
  archiveForNewTask(): void {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const historyDir = path.join(this.brainDir, 'history', ts);
    fs.mkdirSync(historyDir, { recursive: true });

    const filesToArchive = [
      'knowledge.md',
      'constraints.md',
      'milestones.md',
      'environment.md',
      'execution-context.json',
      // 注意：skills.md（索引）和 skills/（技能文件）不归档，跨任务保留
    ];

    for (const file of filesToArchive) {
      const src = this.p(file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(historyDir, file));
        fs.writeFileSync(src, '', 'utf8');  // 清空，保留文件存在
      }
    }

    // controller-state 重置为初始状态
    this.writeState({ mode: 'DECOMPOSE', replanCount: 0, replanReason: null, blockedReason: null });
  }

  /**
   * 截取 content 最后 maxChars 字符（偏向最新内容），
   * 超限时加 …(省略前文) 提示。
   */
  static tail(content: string, maxChars: number): string {
    if (content.length <= maxChars) return content;
    return `…（省略前文 ${content.length - maxChars} 字符，仅展示最近内容）\n` +
      content.slice(content.length - maxChars);
  }
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

/** 简单分词：中文 2-gram + 英文空格切割，过滤停用词 */
function tokenize(text: string): Set<string> {
  const STOP = new Set(['的', '了', '在', '是', '和', '或', '与', '等', '及', 'the', 'a', 'an', 'to', 'of', 'for', 'in', 'on', 'at', 'by']);
  const words = new Set<string>();
  // 英文单词
  for (const w of text.toLowerCase().split(/[\s,，、；;:：\-_/\\[\]()（）]+/)) {
    if (w.length > 1 && !STOP.has(w)) words.add(w);
  }
  // 中文 2-gram
  const cjk = text.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i < cjk.length - 1; i++) {
    const gram = cjk.slice(i, i + 2);
    if (!STOP.has(gram)) words.add(gram);
  }
  return words;
}

function defaultState(): ControllerState {
  return { mode: 'DECOMPOSE', replanCount: 0, replanReason: null, blockedReason: null, sleepUntil: null, cycleCount: 0, awaitingReason: null };
}

/**
 * 解析 milestones.md 全文：里程碑标题行 + 紧随其后的 `> 标签：内容` 约定行。
 */
export function parseMilestonesFromContent(content: string, warnOnFail?: (line: string) => void): Milestone[] {
  const results: Milestone[] = [];
  let cur: Milestone | null = null;

  for (const raw of content.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

    if (/^\s*[>›]/.test(trimmed)) {
      if (cur) applyMilestoneContractLine(cur, trimmed);
      continue;
    }

    if (trimmed.startsWith('[')) {
      const m = parseMilestoneLine(trimmed);
      if (m) {
        results.push(m);
        cur = m;
      } else {
        cur = null;
        if (warnOnFail) warnOnFail(trimmed);
      }
    }
  }
  return results;
}

/** 将 `> 标签：内容` 合并进里程碑（由 parseMilestonesFromContent 调用） */
export function applyMilestoneContractLine(m: Milestone, line: string): void {
  const stripped = line.replace(/^\s*[>›]\s*/, '').trim();
  const match = stripped.match(/^([^:：]+)[:：]\s*(.*)$/);
  if (!match) return;
  const label = match[1]!.trim();
  const value = match[2]!.trim();
  if (!value) return;

  const mergeField = (field: 'dependsOn' | 'inputsScope' | 'outputsContract' | 'operationsAvoid') => {
    const prev = m[field];
    m[field] = prev ? `${prev}\n${value}` : value;
  };

  if (/^(输入范围|允许材料|允许读)/i.test(label)) mergeField('inputsScope');
  else if (/^(必交付|输出要求|交付物)/i.test(label)) mergeField('outputsContract');
  else if (/^(禁止|避免|尽量减少)/i.test(label)) mergeField('operationsAvoid');
  else if (/^(前置|依赖)/i.test(label)) mergeField('dependsOn');
}

/** 供 Executor / Attributor 注入用户消息的契约正文（无契约则返回空串） */
export function formatMilestoneContractForPrompt(m: Milestone): string {
  const lines: string[] = [];
  if (m.dependsOn) lines.push(`**前置依赖**：${m.dependsOn}`);
  if (m.inputsScope) {
    lines.push(
      `**输入范围**（优先仅使用这些材料；除非发现明确缺口，不要扩大读盘或重复全量扫源码）：${m.inputsScope}`,
    );
  }
  if (m.outputsContract) lines.push(`**必交付物**（本轮结束应有可核对产出）：${m.outputsContract}`);
  if (m.operationsAvoid) lines.push(`**禁止或尽量减少**：${m.operationsAvoid}`);
  return lines.join('\n');
}

/**
 * 解析单行里程碑。
 *
 * 支持两种格式：
 *   普通：[M1] [Active]           Title — Description
 *   循环：[M1] [Active] [cyclic:N] Title — Description
 *
 * N 为循环间隔毫秒数，例如 [cyclic:86400000] = 24 小时。
 */
export function parseMilestoneLine(line: string): Milestone | null {
  // 先尝试带 cyclic 标签的格式
  const cyclic = line.match(
    /^\s*\[(\w+)\]\s+\[(Active|Pending|Completed)\]\s+\[cyclic:(\d+)\]\s+(.+?)\s+[—–-]\s+(.+)\s*$/u
  );
  if (cyclic && cyclic[1] && cyclic[2] && cyclic[3] && cyclic[4] && cyclic[5]) {
    return {
      id:              cyclic[1],
      status:          cyclic[2] as 'Active' | 'Pending' | 'Completed',
      title:           cyclic[4].trim(),
      description:     cyclic[5].trim(),
      cyclic:          true,
      cycleIntervalMs: parseInt(cyclic[3], 10),
    };
  }

  // Accept em-dash, en-dash, or ` - ` as separator
  const m = line.match(
    /^\s*\[(\w+)\]\s+\[(Active|Pending|Completed)\]\s+(.+?)\s+[—–-]\s+(.+)\s*$/u
  );
  if (!m || !m[1] || !m[2] || !m[3] || !m[4]) return null;
  return {
    id: m[1],
    status: m[2] as 'Active' | 'Pending' | 'Completed',
    title: m[3].trim(),
    description: m[4].trim(),
  };
}

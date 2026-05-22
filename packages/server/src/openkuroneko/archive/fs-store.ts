/**
 * FilesystemStore — KnowledgeStore 的文件系统实现
 *
 * 并发安全原则：
 *   1. sessionId = agentId + timestamp_ms，全局唯一，不同 agent 永远写不同文件
 *   2. Write-then-Rename：先写 sessions/<id>-wip/，原子 rename 为 sessions/<id>/
 *   3. index/<id>.json 在 rename 之后写，是"session 可见"的信号
 *   4. 读取只访问 immutable 文件（index json + session md），无锁
 *   5. 初始化时清理 *-wip/ 孤儿目录（崩溃恢复）
 *
 * 存储布局（~/.openkuroneko/knowledge-base/ 下）：
 *   index/
 *     <sessionId>.json      # SessionMeta（写后不修改）
 *   sessions/
 *     <sessionId>/          # 归档内容（rename 后不修改）
 *       meta.json
 *       constraints.md
 *       skills.md
 *       knowledge.md
 *       reflexion.json      # 可选
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { KnowledgeStore, SessionMeta, RetrievedSession, RetrieveOptions } from './types.js';
import type { BrainFS } from '../brain/index.js';

// ── 停用词（中英文常见虚词） ───────────────────────────────────────────────────

const STOP_WORDS = new Set([
  // 中文
  '的', '是', '了', '在', '和', '与', '或', '一', '个', '这', '那', '有', '也', '都',
  '为', '对', '从', '到', '以', '可', '我', '你', '他', '她', '它', '我们', '你们',
  '他们', '不', '没', '很', '就', '但', '如果', '因为', '所以', '通过', '已经',
  // 英文
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'on', 'at', 'by', 'for',
  'with', 'from', 'up', 'about', 'into', 'through', 'and', 'or', 'but', 'not',
  'this', 'that', 'these', 'those', 'it', 'its',
]);

const VERDICT_RANK: Record<string, number> = { failed: 0, partial: 1, success: 2 };

// ── 关键词提取 ────────────────────────────────────────────────────────────────

/**
 * 从文本中提取关键词：
 *   - 英文：按空格/标点切分，小写
 *   - 中文：提取连续汉字串（长度 ≥ 2），同时生成 2-gram
 * 过滤停用词后返回去重词列表（最多 30 个）。
 */
export function extractKeywords(text: string): string[] {
  const words = new Set<string>();

  const enWords = text.match(/[a-zA-Z0-9_\u00C0-\u024F]+/g) ?? [];
  for (const w of enWords) {
    const lower = w.toLowerCase();
    if (lower.length >= 2 && !STOP_WORDS.has(lower)) {
      words.add(lower);
    }
  }

  const zhChunks = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) ?? [];
  for (const chunk of zhChunks) {
    if (chunk.length >= 2 && !STOP_WORDS.has(chunk)) {
      words.add(chunk);
    }
    for (let i = 0; i < chunk.length - 1; i++) {
      const bi = chunk.slice(i, i + 2);
      if (!STOP_WORDS.has(bi)) {
        words.add(bi);
      }
    }
  }

  return Array.from(words).slice(0, 30);
}

// ── 相关度评分 ────────────────────────────────────────────────────────────────

/**
 * score = |goalKeywords ∩ sessionKeywords| / max(|sessionKeywords|, 1)
 */
export function scoreSession(goalKeywords: string[], session: SessionMeta): number {
  if (session.goalKeywords.length === 0) return 0;
  const goalSet = new Set(goalKeywords);
  const intersection = session.goalKeywords.filter(k => goalSet.has(k)).length;
  return intersection / session.goalKeywords.length;
}

function countNonEmptyLines(text: string): number {
  return text.split('\n').filter(l => l.trim()).length;
}

function verdictSortKey(verdict?: SessionMeta['verdict']): number {
  return VERDICT_RANK[verdict ?? 'success'] ?? 2;
}

// ── FilesystemStore ───────────────────────────────────────────────────────────

export function createFilesystemStore(baseDir?: string): KnowledgeStore {
  const kbDir = baseDir ?? path.join(os.homedir(), '.openkuroneko', 'knowledge-base');
  const indexDir = path.join(kbDir, 'index');
  const sessionsDir = path.join(kbDir, 'sessions');

  function init(): void {
    fs.mkdirSync(indexDir, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });

    try {
      const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && e.name.endsWith('-wip')) {
          fs.rmSync(path.join(sessionsDir, e.name), { recursive: true, force: true });
        }
      }
    } catch { /* ignore */ }
  }

  init();

  return {
    async archive({ brain, agentId, workDir, trigger, triggerReason, goalText, kpiId, reflexion }) {
      const sessionId = `${agentId}-${Date.now()}`;
      const wipDir    = path.join(sessionsDir, `${sessionId}-wip`);
      const finalDir  = path.join(sessionsDir, sessionId);
      const indexFile = path.join(indexDir, `${sessionId}.json`);

      const constraints = brain.readConstraints();
      const skills      = brain.readSkills();
      const knowledge   = brain.readKnowledge();

      const hasBrainContent =
        !!constraints.trim() || !!skills.trim() || !!knowledge.trim();
      if (!hasBrainContent && !reflexion) return;

      const meta: SessionMeta = {
        sessionId,
        agentId,
        workDir,
        ts: new Date().toISOString(),
        trigger,
        triggerReason: triggerReason.slice(0, 300),
        goalSummary: goalText.slice(0, 200),
        goalKeywords: extractKeywords(goalText),
        ...(kpiId ? { kpiId } : {}),
        ...(reflexion ? { verdict: reflexion.verdict, reflexion } : {}),
        counts: {
          constraints: countNonEmptyLines(constraints),
          skills:      countNonEmptyLines(skills),
          knowledge:   countNonEmptyLines(knowledge),
        },
      };

      fs.mkdirSync(wipDir, { recursive: true });
      fs.writeFileSync(path.join(wipDir, 'constraints.md'), constraints, 'utf8');
      fs.writeFileSync(path.join(wipDir, 'skills.md'),      skills,      'utf8');
      fs.writeFileSync(path.join(wipDir, 'knowledge.md'),   knowledge,   'utf8');
      fs.writeFileSync(path.join(wipDir, 'meta.json'),      JSON.stringify(meta, null, 2), 'utf8');
      if (reflexion) {
        fs.writeFileSync(path.join(wipDir, 'reflexion.json'), JSON.stringify(reflexion, null, 2), 'utf8');
      }

      fs.renameSync(wipDir, finalDir);
      fs.writeFileSync(indexFile, JSON.stringify(meta), 'utf8');
    },

    async retrieve(goalText, opts = {}) {
      const {
        maxSessions         = 3,
        constraintThreshold = 0.1,
        skillThreshold      = 0.2,
        knowledgeThreshold  = 0.4,
        maxCharsPerType     = 800,
        kpiId,
      } = opts;

      const goalKeywords = extractKeywords(goalText);

      let indexFiles: string[];
      try {
        indexFiles = fs.readdirSync(indexDir).filter(f => f.endsWith('.json'));
      } catch {
        return [];
      }

      const scored: Array<{ meta: SessionMeta; score: number }> = [];

      for (const file of indexFiles) {
        try {
          const raw  = fs.readFileSync(path.join(indexDir, file), 'utf8');
          const meta = JSON.parse(raw) as SessionMeta;

          if (kpiId && meta.kpiId === kpiId) {
            scored.push({ meta, score: 1 });
            continue;
          }

          const score = scoreSession(goalKeywords, meta);
          if (
            score >= constraintThreshold ||
            score >= skillThreshold      ||
            score >= knowledgeThreshold
          ) {
            scored.push({ meta, score });
          }
        } catch { /* skip */ }
      }

      scored.sort((a, b) => {
        if (kpiId) {
          const aMatch = a.meta.kpiId === kpiId ? 0 : 1;
          const bMatch = b.meta.kpiId === kpiId ? 0 : 1;
          if (aMatch !== bMatch) return aMatch - bMatch;
          if (a.meta.kpiId === kpiId && b.meta.kpiId === kpiId) {
            const vd = verdictSortKey(a.meta.verdict) - verdictSortKey(b.meta.verdict);
            if (vd !== 0) return vd;
          }
        }
        return b.score - a.score;
      });

      const top = scored.slice(0, maxSessions);
      const results: RetrievedSession[] = [];

      for (const { meta, score } of top) {
        const sessionDir = path.join(sessionsDir, meta.sessionId);
        if (!fs.existsSync(sessionDir)) continue;

        const effectiveScore = kpiId && meta.kpiId === kpiId ? 1 : score;

        function readTrunc(name: string, threshold: number): string {
          if (effectiveScore < threshold) return '';
          try {
            const content = fs.readFileSync(path.join(sessionDir, name), 'utf8').trim();
            return content.length > maxCharsPerType
              ? content.slice(0, maxCharsPerType) + '\n…（内容已截断）'
              : content;
          } catch {
            return '';
          }
        }

        results.push({
          meta,
          score: effectiveScore,
          constraints: readTrunc('constraints.md', constraintThreshold),
          skills:      readTrunc('skills.md',      skillThreshold),
          knowledge:   readTrunc('knowledge.md',   knowledgeThreshold),
        });
      }

      return results;
    },

    buildContext(sessions) {
      if (sessions.length === 0) return '';

      const parts: string[] = [];

      const reflexionSessions = sessions.filter((s) => s.meta.reflexion);
      if (reflexionSessions.length > 0) {
        parts.push('## 本 KPI 历次反思');
        parts.push('> 来自同 KPI 过往 burst 的结构化复盘。硬失败方向请勿重试；换向建议优先采纳。');
        for (const s of reflexionSessions) {
          const r = s.meta.reflexion!;
          const date = s.meta.ts.slice(0, 10);
          parts.push(`\n### ${s.meta.goalSummary.slice(0, 60)}（${date}，verdict=${r.verdict}）`);
          if (r.hardFailures.length > 0) {
            parts.push('**硬失败（禁止重试）：**');
            for (const f of r.hardFailures) parts.push(`- ${f}`);
          }
          if (r.softFailures.length > 0) {
            parts.push('**软失败（低优先级）：**');
            for (const f of r.softFailures) parts.push(`- ${f}`);
          }
          if (r.nextStrategy) {
            parts.push(`**换向建议：** ${r.nextStrategy}`);
          }
        }
        parts.push('');
      }

      parts.push(
        '## 历史经验（来自过往相关任务）',
        '> 以下内容自动从历史归因产出中提取。Constraints 中的红线请严格遵守；Skills 和 Knowledge 仅供参考。',
      );

      for (const s of sessions) {
        const { meta, constraints, skills, knowledge } = s;
        const date    = meta.ts.slice(0, 10);
        const trigger = meta.trigger === 'COMPLETE'     ? '成功完成'
                      : meta.trigger === 'BLOCK'        ? '遇到阻塞'
                      : meta.trigger === 'REPLAN_LIMIT' ? '重规划超限'
                      :                                   '循环上限达到';

        parts.push(`\n### 来源：${meta.goalSummary}（${trigger}，${date}）`);

        if (constraints) {
          parts.push('**约束（必须遵守）：**');
          parts.push(constraints);
        }
        if (skills) {
          parts.push('**技能（参考）：**');
          parts.push(skills);
        }
        if (knowledge) {
          parts.push('**知识（参考）：**');
          parts.push(knowledge);
        }
      }

      return parts.join('\n');
    },
  };
}

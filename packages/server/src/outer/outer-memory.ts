/**
 * 外脑记忆层（OuterMemoryStore）
 *
 * 双后端：
 *   - drive9  — 任务状态（精确原文，重启后可还原）
 *   - mem9    — 对话日志 + 内脑发现（语义检索，LLM 整理）
 *
 * 记忆命名空间（mem9 agentId）：
 *   - `${agentSid}:chat`  — 对话日志 + 内脑 ingest
 *
 * 设计要点：
 *   - appendChatLog / writeTasks 均 fire-and-forget，不阻塞主流程
 *   - readTasks 同步返回内存缓存（cache-first），保证工具调用不引入等待
 *   - readChatLog / readMemoryContext 为 async（需要 mem9 search）
 *   - 未配置 MEM9_API_KEY 时，对话读操作返回空；未配置 DRIVE9_API_KEY 时，tasks 仅驻留内存
 */

import fs from 'node:fs';
import path from 'node:path';
import { Mem9Client } from '../mem9/mem9-client.js';
import { getDrive9Client } from '../drive9/drive9-client.js';

export type { Mem9Client };

// ── 类型 ─────────────────────────────────────────────────────────────────────

export interface DailyLogEntry {
  threadId: string;
  userSid: string;
  /** 对话摘要（建议 ≤ 100 字符） */
  summary: string;
}

export interface MemoryContext {
  dailyLog: string;
  tasks: string;
  hasAny: boolean;
}

// ── OuterMemoryStore ─────────────────────────────────────────────────────────

export class OuterMemoryStore {
  private tasksCache = '';
  readonly chatAgentId: string;
  /** drive9 上任务状态文件路径，如 tasks/kuro.md */
  private readonly tasksD9Path: string;

  constructor(
    readonly mem9: Mem9Client | null,
    readonly agentSid: string,
  ) {
    this.chatAgentId = `${agentSid}:chat`;
    this.tasksD9Path = `tasks/${agentSid}.md`;
  }

  /**
   * 异步初始化：优先从 drive9 加载任务状态（精确原文），drive9 不可用时跳过。
   * 建议在 OuterBrain 启动时调用一次。
   */
  async init(): Promise<void> {
    const d9 = getDrive9Client();
    if (d9) {
      try {
        const raw = await d9.read(this.tasksD9Path);
        if (raw.trim()) {
          this.tasksCache = raw.trim();
          console.log('[outer-memory] tasks 已从 drive9 加载');
          return;
        }
      } catch {
        // 文件不存在（404）时正常，无需警告
      }
    }
  }

  // ── 对话日志（Chat Log） ────────────────────────────────────────────────────

  /** 追加对话日志（fire-and-forget）。 */
  appendChatLog(entry: DailyLogEntry): void {
    if (!this.mem9) return;
    const ts      = new Date().toISOString().slice(0, 16).replace('T', ' '); // 2026-04-08 14:30
    const content = `[${ts}] @${entry.userSid} (${entry.threadId}): ${entry.summary.slice(0, 120)}`;
    void this.mem9
      .store({ content, agentId: this.chatAgentId, metadata: { ts: new Date().toISOString() } })
      .catch(() => {});
  }

  /**
   * 读取对话日志（支持语义过滤）。
   * query 为空时列出最近记录，有值时做语义搜索。
   */
  async readChatLog(limit = 30, query?: string): Promise<string> {
    if (!this.mem9) return '（未配置 MEM9_API_KEY）';
    try {
      const mems = await this.mem9.search({ agentId: this.chatAgentId, query, limit });
      if (mems.length === 0) return '（暂无对话日志）';
      // 优先用服务端原生字段 created_at（不经 LLM 修改，最可靠），
      // 回退到我们在 metadata.ts 写入的 ISO 字符串。
      // 升序（旧→新），LLM 阅读更自然。
      const sorted = [...mems].sort((a, b) => {
        const ta = a.created_at ?? (a.metadata?.['ts'] as string | undefined) ?? '';
        const tb = b.created_at ?? (b.metadata?.['ts'] as string | undefined) ?? '';
        return ta < tb ? -1 : ta > tb ? 1 : 0;
      });
      return sorted.map((m) => `- ${m.content}`).join('\n');
    } catch (e) {
      return `（mem9 搜索失败：${(e as Error).message}）`;
    }
  }

  // ── 任务状态（Tasks） ───────────────────────────────────────────────────────

  /** 读取任务状态（同步，从内存缓存）。 */
  readTasks(): string {
    return this.tasksCache || '（暂无任务状态。可用 update_tasks 工具初始化。）';
  }

  /** 写入任务状态。同步更新内存缓存 + fire-and-forget 写入 drive9（精确原文）。 */
  writeTasks(content: string): void {
    this.tasksCache = content.trim();
    const d9 = getDrive9Client();
    if (d9) {
      void d9.write(this.tasksD9Path, this.tasksCache)
        .catch((e: unknown) =>
          console.warn('[outer-memory] drive9 writeTasks 失败:', (e as Error).message),
        );
    }
  }

  // ── 组合上下文（供 LLM 注入） ────────────────────────────────────────────────

  async readMemoryContext(chatQuery?: string): Promise<MemoryContext> {
    const dailyLog = await this.readChatLog(50, chatQuery);
    const tasks    = this.readTasks();
    const hasAny   = !!this.mem9 && (
      dailyLog !== '（暂无对话日志）' && dailyLog !== '（未配置 MEM9_API_KEY）' ||
      !!this.tasksCache
    );
    return { dailyLog, tasks, hasAny };
  }

  formatMemoryForLlm(ctx: MemoryContext): string {
    if (!ctx.hasAny) return '';
    return [
      '## 记忆',
      '',
      '### 当前任务状态',
      ctx.tasks,
      '',
      '### 最近对话日志',
      ctx.dailyLog,
    ].join('\n');
  }

  // ── 内脑输出 → mem9 自动提取 ───────────────────────────────────────────────

  /**
   * 内脑完成后调用：读取 output 文件 + 日志，ingest 到外脑 mem9（fire-and-forget）。
   * mem9 以 mode:"smart" 从对话内容中自动提取多条洞见，供外脑语义检索。
   */
  ingestInnerOutput(workDir: string, workspaceId: string): void {
    if (!this.mem9) return;
    const mem9 = this.mem9;
    const agentId = this.chatAgentId;

    void (async () => {
      const messages: Array<{ role: string; content: string }> = [];

      // 1. 完成报告正文（结果优先，避免把整份 output/日志过程灌进 mem9）
      const { buildCompletionMessageFromWorkspace } = await import('./completion-notify.js');
      const { message: completionBody } = buildCompletionMessageFromWorkspace(workDir, {
        audience: 'verbose',
      });
      if (completionBody.trim()) {
        messages.push({ role: 'assistant', content: `[内脑任务完成报告]\n${completionBody}` });
      }

      if (messages.length === 0) return;

      try {
        await mem9.ingest({
          messages,
          session_id: `inner:${workspaceId}:${Date.now()}`,
          agent_id:   agentId,
          mode:       'smart',
        });
        console.log(`[outer-memory] inner output ingested to mem9 (workspaceId=${workspaceId})`);
      } catch (e) {
        console.warn('[outer-memory] ingestInnerOutput 失败:', (e as Error).message);
      }
    })();
  }

  // ── 供 dashboard API 读取 ──────────────────────────────────────────────────

  async readDailyLogRaw(maxLines = 200): Promise<string> {
    return this.readChatLog(maxLines);
  }

  readTasksRaw(): string {
    return this.tasksCache || '（暂无任务状态。）';
  }
}

// ── 工厂函数：从环境变量创建 OuterMemoryStore ────────────────────────────────

export function createMemoryStore(_dataRoot: string, agentSid: string): OuterMemoryStore {
  const apiKey = process.env['MEM9_API_KEY']?.trim();
  const apiUrl = process.env['MEM9_API_URL']?.trim();

  if (apiKey) {
    const mem9 = new Mem9Client({ apiKey, apiUrl });
    console.log(`[outer-memory] mem9 已启用 agentSid=${agentSid} url=${apiUrl ?? 'https://api.mem9.ai'}`);
    return new OuterMemoryStore(mem9, agentSid);
  }

  console.log('[outer-memory] MEM9_API_KEY 未设置，记忆层不可用');
  return new OuterMemoryStore(null, agentSid);
}

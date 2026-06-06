/**
 * Push Loop — 内脑输出主动推送（对齐 openKuroneko push-loop.ts）
 *
 * 轮询所有活跃内脑实例的 Pi-mono output 文件，解析 BLOCK / COMPLETE / PROGRESS 事件：
 *
 * BLOCK：
 *   仅记日志，不推 IM（AWAITING_HUMAN 由 onExit awaitingNotify 统一发送）。
 *
 * COMPLETE：
 *   向 originThread 发送完成通知，附带产出文件列表（通过 IM postMessage）。
 *
 * PROGRESS：
 *   仅记录日志（默认不推送，可通过 UTLRA_PUSHLOOP_PROGRESS=1 开启）。
 *
 * 适配 utlraKuroneko 架构差异：
 *   - openKuroneko 读 <tempDir>/output（子进程写入）
 *   - utlraKuroneko 读 <workDir>/.run/pi-mono/output（内嵌 Pi-mono 写入）
 *   - 通知通过 ChatIRChannel.postMessage 而非 ChannelRegistry.send
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ChatIRChannel } from '@utlra/chat-ir';
import type { InnerBrainRegistry, TaskRecord } from './inner-brain-registry.js';

// ── 常量 ───────────────────────────────────────────────────────────────────

// ── 事件类型 ────────────────────────────────────────────────────────────────

export interface InnerBrainOutput {
  type: 'BLOCK' | 'COMPLETE' | 'PROGRESS';
  message: string;
  target_user?: string;
  question?: string;
  ts: string;
  deliverables?: string[];
}

// ── PushLoop ────────────────────────────────────────────────────────────────

export interface PushLoopOptions {
  registry:    InnerBrainRegistry;
  imClient:    ChatIRChannel;
  agentSid:    string;
  /** 轮询间隔（ms），默认 2000 */
  pollMs?: number;
}

export class PushLoop {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 每个实例独立维护 output 文件偏移量（持久化到磁盘，防重启重复处理） */
  private readonly offsets: Map<string, number> = new Map();

  constructor(private readonly opts: PushLoopOptions) {}

  start(): void {
    this.timer = setInterval(() => {
      this.tick().catch((e) =>
        console.error('[utlra][push-loop] tick error:', e),
      );
    }, this.opts.pollMs ?? 2000);
    console.log('[utlra][push-loop] started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ── 轮询主循环 ─────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    // RUNNING：正常轮询；BLOCKED / AWAITING：仍需扫 output 把通知发给用户
    const active = this.opts.registry.list().filter(
      (r) => r.status === 'RUNNING' || r.status === 'BLOCKED' || r.status === 'AWAITING',
    );
    for (const inst of active) {
      await this.tickInstance(inst);
    }
  }

  private async tickInstance(inst: TaskRecord): Promise<void> {
    // Pi-mono output 文件路径（内嵌运行时写入位置）
    const outputFile = path.join(inst.workDir, '.run', 'pi-mono', 'output');
    if (!fs.existsSync(outputFile)) return;

    const instanceId = inst.instanceId;

    // 首次读取：从磁盘恢复 offset（外脑重启后不重复推送）
    if (!this.offsets.has(instanceId)) {
      this.offsets.set(instanceId, this.loadOffset(inst.workDir));
    }

    const newContent = this.readNewContent(instanceId, inst.workDir, outputFile);
    if (!newContent) return;

    const events = parseInnerOutputLines(newContent);
    for (const ev of events) {
      console.log(`[utlra][push-loop] ${instanceId} event=${ev.type}: ${ev.message.slice(0, 80)}`);
      switch (ev.type) {
        case 'BLOCK':    this.handleBlock(inst, ev);           break;
        case 'COMPLETE': await this.handleComplete(inst, ev); break;
        case 'PROGRESS': this.handleProgress(inst, ev);       break;
      }
    }
  }

  // ── 事件处理 ────────────────────────────────────────────────────────────

  private handleBlock(inst: TaskRecord, output: InnerBrainOutput): void {
    const question = (output.question ?? output.message).slice(0, 120);
    console.log(
      `[utlra][push-loop] BLOCK logged only (IM delegated to awaitingNotify): ${inst.instanceId} q=${question}`,
    );
  }

  private handleComplete(inst: TaskRecord, output: InnerBrainOutput): void {
    // COMPLETE 通知由 onExit 回调统一发送（onExit 是进程退出的确定时机）。
    // PushLoop 仅记录日志并更新 offset，避免与 onExit 双重发送。
    console.log(
      `[utlra][push-loop] COMPLETE detected (notification delegated to onExit): ${inst.instanceId} msg=${output.message.slice(0, 80)}`,
    );
  }

  private handleProgress(inst: TaskRecord, output: InnerBrainOutput): void {
    // 全局开关 UTLRA_PUSHLOOP_PROGRESS=1，或在 workspace 创建 .run/push-progress 文件开启 per-instance 推送
    const pushProgress =
      process.env['UTLRA_PUSHLOOP_PROGRESS'] === '1' ||
      fs.existsSync(path.join(inst.workDir, '.run', 'push-progress'));
    if (!pushProgress) {
      console.log(`[utlra][push-loop] ${inst.instanceId} PROGRESS: ${output.message.slice(0, 80)}`);
      return;
    }

    const threadId = inst.originThread;
    if (!threadId) return;

    void this.sendToThread(
      threadId,
      `🔄 任务 \`${inst.instanceId}\` 进度：${output.message.slice(0, 200)}`,
    );
  }

  // ── 发送消息 ─────────────────────────────────────────────────────────────

  private async sendToThread(threadId: string, text: string): Promise<void> {
    try {
      await this.opts.imClient.postMessage(threadId, {
        sender_sid: this.opts.agentSid,
        text,
      });
    } catch (e) {
      console.error(`[utlra][push-loop] postMessage failed (${threadId}):`, e);
    }
  }

  // ── offset 持久化（防重启重复推送）────────────────────────────────────

  private loadOffset(workDir: string): number {
    const f = path.join(workDir, '.run', 'push-loop.offset');
    try {
      const v = parseInt(fs.readFileSync(f, 'utf8'), 10);
      return isNaN(v) ? 0 : v;
    } catch {
      return 0;
    }
  }

  private saveOffset(instanceId: string, workDir: string, offset: number): void {
    try {
      const f = path.join(workDir, '.run', 'push-loop.offset');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, String(offset), 'utf8');
    } catch { /* non-critical */ }
    this.offsets.set(instanceId, offset);
  }

  private readNewContent(
    instanceId: string,
    workDir: string,
    filePath: string,
  ): string | null {
    let stat: fs.Stats;
    try { stat = fs.statSync(filePath); } catch { return null; }

    const offset = this.offsets.get(instanceId) ?? 0;
    if (stat.size <= offset) return null;

    const fd  = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(stat.size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);

    this.saveOffset(instanceId, workDir, stat.size);
    const content = buf.toString('utf8').trim();
    return content || null;
  }
}

// ── 辅助函数 ────────────────────────────────────────────────────────────────

function parseInnerOutputLines(content: string): InnerBrainOutput[] {
  const lines  = content.split('\n').map((l) => l.trim()).filter(Boolean);
  const events: InnerBrainOutput[] = [];

  for (const line of lines) {
    events.push(parseSingleLine(line));
  }

  return events.length > 0
    ? events
    : [{ type: 'PROGRESS', message: content, ts: new Date().toISOString() }];
}

function parseSingleLine(line: string): InnerBrainOutput {
  try {
    const obj = JSON.parse(line) as Partial<InnerBrainOutput>;
    if (obj.type && obj.message) {
      const out: InnerBrainOutput = {
        type:        obj.type as InnerBrainOutput['type'],
        message:     obj.message,
        target_user: obj.target_user,
        question:    obj.question,
        ts:          obj.ts ?? new Date().toISOString(),
      };
      if (obj.type === 'COMPLETE' && Array.isArray(obj.deliverables)) {
        out.deliverables = obj.deliverables.filter((x): x is string => typeof x === 'string');
      }
      return out;
    }
  } catch { /* not JSON */ }

  const ts = new Date().toISOString();
  if (line.startsWith('[BLOCK]'))    return { type: 'BLOCK',    message: line.replace('[BLOCK]', '').trim(),    question: line.replace('[BLOCK]', '').trim(), ts };
  if (line.startsWith('[COMPLETE]')) return { type: 'COMPLETE', message: line.replace('[COMPLETE]', '').trim(), ts };
  return { type: 'PROGRESS', message: line, ts };
}

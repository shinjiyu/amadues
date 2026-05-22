/**
 * KnowledgeStore (FilesystemStore) 单元测试 — 聚焦 KPI / verdict / reflexion 新增逻辑
 *
 * 守住的契约：
 *   - 同 kpiId 的 session 在 retrieve 时永远比无关 session 优先（即使关键词不匹配）
 *   - 同 kpiId 内 verdict='failed' 排在 'partial' 前，'partial' 排在 'success' 前
 *   - reflexion 写入 meta.json 同时落 reflexion.json
 *   - buildContext 把 reflexion 单独放在最上方"本 KPI 历次反思"区块
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFilesystemStore } from './fs-store.js';
import { BrainFS } from '../brain/brain-fs.js';

let kbDir: string;
let workspaceRoot: string;

beforeEach(() => {
  kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuroneko-kb-'));
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kuroneko-ws-'));
});

afterEach(() => {
  for (const d of [kbDir, workspaceRoot]) {
    if (d && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  }
});

/** 用 BrainFS 在一个临时 workspace 里写好 goal / constraints / skills / knowledge，再触发 archive */
async function archiveSession(opts: {
  agentId: string;
  goalText: string;
  triggerReason: string;
  kpiId?: string;
  verdict?: 'success' | 'partial' | 'failed';
  hardFailures?: string[];
}): Promise<string> {
  const wsId = `ws-${opts.agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const workDir = path.join(workspaceRoot, wsId);
  fs.mkdirSync(workDir, { recursive: true });
  const brain = new BrainFS(workDir);
  brain.writeGoal(opts.goalText);
  brain.appendConstraint(`[红线] 给 ${opts.agentId} 的约束`);
  brain.appendKnowledge(`[事实] knowledge for ${opts.agentId}`);
  const store = createFilesystemStore(kbDir);
  await store.archive({
    brain,
    agentId: opts.agentId,
    workDir,
    trigger: opts.verdict === 'success' ? 'COMPLETE' : 'BLOCK',
    triggerReason: opts.triggerReason,
    goalText: opts.goalText,
    ...(opts.kpiId ? { kpiId: opts.kpiId } : {}),
    ...(opts.verdict ? {
      reflexion: {
        verdict: opts.verdict,
        hardFailures: opts.hardFailures ?? [],
        softFailures: [],
        nextStrategy: opts.verdict === 'failed' ? '换方向 X' : '',
      },
    } : {}),
  });
  return workDir;
}

describe('FilesystemStore.archive 写入 KPI/reflexion 字段', () => {
  it('archive 时把 kpiId + reflexion 写进 SessionMeta，并单独落 reflexion.json', async () => {
    await archiveSession({
      agentId: 'a1',
      goalText: '查到 X 的手机号',
      triggerReason: '走不通',
      kpiId: 'kpi-001',
      verdict: 'failed',
      hardFailures: ['公开 API 拒绝'],
    });

    const indexFiles = fs.readdirSync(path.join(kbDir, 'index'));
    expect(indexFiles).toHaveLength(1);
    const meta = JSON.parse(fs.readFileSync(path.join(kbDir, 'index', indexFiles[0]!), 'utf8'));
    expect(meta.kpiId).toBe('kpi-001');
    expect(meta.verdict).toBe('failed');
    expect(meta.reflexion?.hardFailures).toEqual(['公开 API 拒绝']);

    // session dir 里有 reflexion.json
    const sessionDir = path.join(kbDir, 'sessions', meta.sessionId);
    expect(fs.existsSync(path.join(sessionDir, 'reflexion.json'))).toBe(true);
    const refRaw = JSON.parse(fs.readFileSync(path.join(sessionDir, 'reflexion.json'), 'utf8'));
    expect(refRaw.verdict).toBe('failed');
  });
});

describe('FilesystemStore.retrieve KPI 优先 + verdict 排序', () => {
  it('传 kpiId 时，同 KPI 的 session 即使关键词完全不匹配也进入结果', async () => {
    // 一个跟 goal 完全不相关的 KPI session
    await archiveSession({
      agentId: 'a1',
      goalText: '与狗有关的训练任务',
      triggerReason: '...',
      kpiId: 'kpi-X',
      verdict: 'failed',
    });
    // 一个跟 goal 高度相关但属于另一个 KPI 的 session
    await archiveSession({
      agentId: 'a2',
      goalText: '抓取股票数据并生成报告',
      triggerReason: '...',
      kpiId: 'kpi-Y',
      verdict: 'success',
    });

    const store = createFilesystemStore(kbDir);
    const sessions = await store.retrieve('抓取股票数据并生成报告', { kpiId: 'kpi-X' });
    expect(sessions.length).toBeGreaterThan(0);
    // 同 KPI 的优先（即使关键词不匹配）
    expect(sessions[0]?.meta.kpiId).toBe('kpi-X');
  });

  it('同 KPI 内 failed > partial > success（避免重撞墙最重要）', async () => {
    await archiveSession({
      agentId: 'a-success', goalText: '同 KPI 任务',
      triggerReason: '完成', kpiId: 'kpi-Z', verdict: 'success',
    });
    await archiveSession({
      agentId: 'a-partial', goalText: '同 KPI 任务',
      triggerReason: '部分', kpiId: 'kpi-Z', verdict: 'partial',
    });
    await archiveSession({
      agentId: 'a-failed', goalText: '同 KPI 任务',
      triggerReason: '失败', kpiId: 'kpi-Z', verdict: 'failed',
    });

    const store = createFilesystemStore(kbDir);
    const sessions = await store.retrieve('同 KPI 任务', { kpiId: 'kpi-Z', maxSessions: 10 });
    expect(sessions).toHaveLength(3);
    expect(sessions[0]?.meta.verdict).toBe('failed');
    expect(sessions[1]?.meta.verdict).toBe('partial');
    expect(sessions[2]?.meta.verdict).toBe('success');
  });

  it('不传 kpiId 时走原关键词匹配路径（不引入回归）', async () => {
    await archiveSession({
      agentId: 'a1', goalText: '抓取股票数据生成报告',
      triggerReason: '...', kpiId: 'kpi-Y', verdict: 'success',
    });

    const store = createFilesystemStore(kbDir);
    const sessions = await store.retrieve('抓取股票数据生成报告');
    expect(sessions.length).toBe(1);
  });
});

describe('FilesystemStore.buildContext 反思优先展示', () => {
  it('反思 session 会单独放在 "本 KPI 历次反思" 区块且在历史经验之前', async () => {
    await archiveSession({
      agentId: 'a1', goalText: 'goal',
      triggerReason: '失败', kpiId: 'kpi-A',
      verdict: 'failed', hardFailures: ['X 死路'],
    });

    const store = createFilesystemStore(kbDir);
    const sessions = await store.retrieve('goal', { kpiId: 'kpi-A' });
    const ctx = store.buildContext(sessions);
    expect(ctx).toContain('本 KPI 历次反思');
    expect(ctx).toContain('X 死路');
    expect(ctx).toContain('换方向 X');
    // 反思区块在普通"历史经验"区块之前
    expect(ctx.indexOf('本 KPI 历次反思')).toBeLessThan(ctx.indexOf('历史经验'));
  });
});

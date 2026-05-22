/**
 * async-wait 工具行为单测：ask_user / wait_timer / wait_signal
 *
 * 关注点：调用工具会真的把 pending 写进 .brain/pendings.json，
 *         schema 字段正确，超时策略生效。
 */

import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  askUserTool,
  waitTimerTool,
  waitSignalTool,
  setAsyncWaitBrainDir,
  brainDirFromWorkDir,
} from './async-wait.js';
import { readPendings } from '../../pendings/index.js';

function tmpBrain(): { workDir: string; brainDir: string } {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-test-'));
  const brainDir = brainDirFromWorkDir(workDir);
  fs.mkdirSync(brainDir, { recursive: true });
  setAsyncWaitBrainDir(brainDir);
  return { workDir, brainDir };
}

describe('async-wait tools', () => {
  let brainDir: string;
  beforeEach(() => { ({ brainDir } = tmpBrain()); });

  it('ask_user writes pending with prompt + deadline', async () => {
    const res = await askUserTool.call({ prompt: '需要 token', deadline_seconds: 60 });
    expect(res.ok).toBe(true);
    expect(res.output).toContain('已挂起');
    const items = readPendings(brainDir);
    expect(items.length).toBe(1);
    expect(items[0]?.kind).toBe('ask_user');
    expect(items[0]?.status).toBe('pending');
    expect((items[0]?.spec as { prompt: string }).prompt).toBe('需要 token');
    expect(items[0]?.deadline).toBeTruthy();
  });

  it('ask_user requires prompt', async () => {
    const res = await askUserTool.call({});
    expect(res.ok).toBe(false);
  });

  it('wait_timer with delay_seconds creates timer pending', async () => {
    const res = await waitTimerTool.call({ delay_seconds: 30, reason: '稍等' });
    expect(res.ok).toBe(true);
    const items = readPendings(brainDir);
    expect(items[0]?.kind).toBe('timer');
    const t = Date.parse((items[0]?.spec as { execute_at: string }).execute_at);
    expect(t).toBeGreaterThan(Date.now() + 20_000);
  });

  it('wait_timer with execute_at honors ISO timestamp', async () => {
    const future = new Date(Date.now() + 7200_000).toISOString();
    const res = await waitTimerTool.call({ execute_at: future });
    expect(res.ok).toBe(true);
    const items = readPendings(brainDir);
    expect((items[0]?.spec as { execute_at: string }).execute_at).toBe(future);
  });

  it('wait_timer rejects bad input', async () => {
    expect((await waitTimerTool.call({})).ok).toBe(false);
    expect((await waitTimerTool.call({ execute_at: 'not-iso' })).ok).toBe(false);
  });

  it('wait_signal creates signal pending', async () => {
    const res = await waitSignalTool.call({ signal_name: 'payment_ok', deadline_seconds: 10 });
    expect(res.ok).toBe(true);
    const items = readPendings(brainDir);
    expect(items[0]?.kind).toBe('signal');
    expect((items[0]?.spec as { signal_name: string }).signal_name).toBe('payment_ok');
  });

  // ── intent 拟人意图测试 ─────────────────────────────────────────────────────

  it('ask_user accepts object intent and persists all three fields', async () => {
    const res = await askUserTool.call({
      prompt: '需要 OAuth token',
      intent: {
        expectation: '用户给 sk- 开头的 token',
        success_signal: '回复以 sk- 开头',
        fallback: '用户回 cancel 则转 OAuth 流',
      },
    });
    expect(res.ok).toBe(true);
    expect(res.output).toContain('已记录意图');
    const items = readPendings(brainDir);
    expect(items[0]?.intent).toEqual({
      expectation: '用户给 sk- 开头的 token',
      success_signal: '回复以 sk- 开头',
      fallback: '用户回 cancel 则转 OAuth 流',
    });
  });

  it('ask_user accepts JSON-string intent (LLM serialization fallback)', async () => {
    const res = await askUserTool.call({
      prompt: '需要凭据',
      intent: JSON.stringify({ expectation: '用户给凭据' }),
    });
    expect(res.ok).toBe(true);
    const items = readPendings(brainDir);
    expect(items[0]?.intent?.expectation).toBe('用户给凭据');
  });

  it('ask_user accepts plain-string intent as expectation', async () => {
    const res = await askUserTool.call({
      prompt: '问个东西',
      intent: '希望用户给出邮件地址',
    });
    expect(res.ok).toBe(true);
    expect(readPendings(brainDir)[0]?.intent?.expectation).toBe('希望用户给出邮件地址');
  });

  it('ask_user without intent stores no intent field', async () => {
    await askUserTool.call({ prompt: '没意图' });
    expect(readPendings(brainDir)[0]?.intent).toBeUndefined();
  });

  it('wait_timer accepts intent and persists it', async () => {
    const res = await waitTimerTool.call({
      delay_seconds: 10,
      reason: '巡检 Shiro',
      intent: { expectation: '估计 Shiro 10 分钟跑完编译', success_signal: 'tick 数推进' },
    });
    expect(res.ok).toBe(true);
    expect(res.output).toContain('已记录意图');
    expect(readPendings(brainDir)[0]?.intent?.expectation).toContain('Shiro');
  });

  it('wait_signal accepts intent and persists it', async () => {
    const res = await waitSignalTool.call({
      signal_name: 'ci_done',
      intent: { expectation: 'CI 推 webhook,payload 含 success=true' },
    });
    expect(res.ok).toBe(true);
    expect(readPendings(brainDir)[0]?.intent?.expectation).toContain('CI');
  });

  it('intent with empty expectation is ignored (defensive)', async () => {
    const res = await askUserTool.call({
      prompt: 'x',
      intent: { expectation: '   ', fallback: '走 fallback' },
    });
    expect(res.ok).toBe(true);
    expect(readPendings(brainDir)[0]?.intent).toBeUndefined();
  });
});

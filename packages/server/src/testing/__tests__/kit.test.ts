/**
 * Testing kit 自检：保证基建工具本身可用。
 *
 * 这套测试**只测 testing kit 自己**，不引用任何业务模块。
 * 任何一项失败 = doc/testing-strategy.md §7 B 阶段 Exit Criteria 没达成。
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  createTestDataRoot,
  FakeImChannel,
  createFakeLLM,
  constLLM,
  createFakeClock,
  realClock,
  loadFixture,
  setFixtureRoot,
  resetFixtureRoot,
  writeSyntheticWorkspace,
} from '../index.js';
import { POST_COMPLETE_REASON } from '../../outer/brain-async-snapshot.js';

describe('testing kit · temp-data-root', () => {
  it('mkdtemp 出独立目录,cleanup 后消失', () => {
    const a = createTestDataRoot('kit-test-a-');
    const b = createTestDataRoot('kit-test-b-');
    expect(a.dataRoot).not.toBe(b.dataRoot);
    expect(fs.existsSync(a.workspacesDir)).toBe(true);
    expect(fs.existsSync(b.workspacesDir)).toBe(true);
    a.cleanup();
    b.cleanup();
    expect(fs.existsSync(a.dataRoot)).toBe(false);
    expect(fs.existsSync(b.dataRoot)).toBe(false);
  });
});

describe('testing kit · FakeImChannel', () => {
  it('记录 outbox 顺序,支持按 thread 过滤与正则匹配', async () => {
    const im = new FakeImChannel();
    await im.postMessage('t-1', { sender_sid: 'a:bot', text: '你好' });
    await im.postMessage('t-2', { sender_sid: 'a:bot', text: '完成 ✅' });
    await im.postMessage('t-1', { sender_sid: 'a:bot', text: '完成 ✅' });

    expect(im.outbox).toHaveLength(3);
    expect(im.lastText('t-1')).toBe('完成 ✅');
    expect(im.lastText('t-2')).toBe('完成 ✅');
    expect(im.messagesMatching(/完成/, 't-1')).toHaveLength(1);
    expect(im.messagesMatching(/完成/)).toHaveLength(2);
  });

  it('wireInbound + emitInbound 触发 handler', async () => {
    const im = new FakeImChannel();
    const seen: string[] = [];
    im.wireInbound(async (ev) => {
      seen.push(ev.threadId);
    });
    await im.emitInbound({
      threadId: 't-wire',
      senderSid: 'human:1',
      participantSids: ['human:1'],
      message: {
        message_id: 'msg:1',
        thread_id: 't-wire',
        sender_sid: 'human:1',
        sent_at: new Date().toISOString(),
        parts: [{ type: 'text', text: 'hi' }],
      },
    });
    expect(seen).toEqual(['t-wire']);
  });
});

describe('testing kit · FakeLLM', () => {
  it('按 systemPrompt 子串命中,默认可重复匹配同一条脚本', async () => {
    const llm = createFakeLLM([
      { label: 'decomposer', match: 'decomposer', reply: { content: 'M1\nM2' } },
      { label: 'attributor', match: 'attributor', reply: { content: 'OK' } },
    ]);

    const r1 = await llm.chat('You are decomposer', [{ role: 'user', content: 'go' }]);
    const r2 = await llm.chat('You are decomposer', [{ role: 'user', content: 'go again' }]);
    expect(r1.content).toBe('M1\nM2');
    expect(r2.content).toBe('M1\nM2');
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[0]!.matchedLabel).toBe('decomposer');
  });

  it('正则匹配 + 函数 reply,calls 记录最终命中', async () => {
    const llm = createFakeLLM([
      {
        label: 'echo-user',
        match: /please-echo/,
        reply: ({ messages }) => {
          const last = messages.at(-1);
          const text = typeof last?.content === 'string' ? last.content : '';
          return { content: text.toUpperCase() };
        },
      },
    ]);
    const r = await llm.chat('please-echo system', [{ role: 'user', content: 'hi' }]);
    expect(r.content).toBe('HI');
  });

  it('未命中默认抛错;silent 模式返回兜底内容', async () => {
    const strict = createFakeLLM([{ match: 'only-this', reply: { content: 'ok' } }]);
    await expect(strict.chat('something-else', [{ role: 'user', content: '?' }])).rejects.toThrow(
      /no script matched/,
    );

    const lenient = createFakeLLM(
      [{ match: 'only-this', reply: { content: 'ok' } }],
      { unmatched: 'silent', silentReply: '<silent>' },
    );
    const r = await lenient.chat('something-else', [{ role: 'user', content: '?' }]);
    expect(r.content).toBe('<silent>');
  });

  it('consumeOnMatch=true 时每条脚本只能命中一次', async () => {
    const llm = createFakeLLM(
      [
        { label: 'first', match: 'go', reply: { content: '1' } },
        { label: 'second', match: 'go', reply: { content: '2' } },
      ],
      { consumeOnMatch: true },
    );
    expect(llm.remaining()).toBe(2);
    const a = await llm.chat('go', [{ role: 'user', content: '' }]);
    const b = await llm.chat('go', [{ role: 'user', content: '' }]);
    expect([a.content, b.content]).toEqual(['1', '2']);
    expect(llm.remaining()).toBe(0);
    await expect(llm.chat('go', [{ role: 'user', content: '' }])).rejects.toThrow();
  });

  it('constLLM 始终返回同一段', async () => {
    const llm = constLLM('fixed');
    const r = await llm.chat('s', [{ role: 'user', content: 'x' }]);
    expect(r.content).toBe('fixed');
  });
});

describe('testing kit · FakeClock', () => {
  it('advance / set 单调向前,iso 与 now 对齐', () => {
    const clock = createFakeClock(new Date('2026-05-16T00:00:00.000Z'));
    expect(clock.iso()).toBe('2026-05-16T00:00:00.000Z');
    clock.advance(60_000);
    expect(clock.iso()).toBe('2026-05-16T00:01:00.000Z');
    clock.set(clock.now() + 120_000);
    expect(clock.iso()).toBe('2026-05-16T00:03:00.000Z');
    expect(() => clock.advance(-1)).toThrow();
    expect(() => clock.set(0)).toThrow();
  });

  it('realClock 返回当前时间,跨多次调用单调不退', () => {
    const t1 = realClock();
    const t2 = realClock();
    expect(t2).toBeGreaterThanOrEqual(t1);
  });
});

describe('testing kit · load-fixture', () => {
  it('setFixtureRoot 临时换路径,loadFixture 读到对应文件', () => {
    const root = createTestDataRoot('kit-fixture-');
    const sub = path.join(root.dataRoot, 'fx');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'hello.txt'), 'world', 'utf8');
    try {
      setFixtureRoot(sub);
      expect(loadFixture('hello.txt')).toBe('world');
      expect(() => loadFixture('missing.txt')).toThrow(/missing fixture/);
    } finally {
      resetFixtureRoot();
      root.cleanup();
    }
  });
});

describe('testing kit · workspace-factory', () => {
  it('writeSyntheticWorkspace(postComplete) 让 controller-state 落入 post-complete', () => {
    const root = createTestDataRoot('kit-ws-');
    const wd = path.join(root.workspacesDir, 'task-1');
    try {
      writeSyntheticWorkspace(wd, {
        goal: '测试',
        deliverables: ['result.md'],
        postComplete: true,
      });
      const state = JSON.parse(
        fs.readFileSync(path.join(wd, '.brain', 'controller-state.json'), 'utf8'),
      ) as { mode: string; blockedReason: string };
      expect(state.mode).toBe('BLOCKED');
      expect(state.blockedReason).toBe(POST_COMPLETE_REASON);
      expect(fs.existsSync(path.join(wd, 'result.md'))).toBe(true);
    } finally {
      root.cleanup();
    }
  });
});

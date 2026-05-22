/**
 * `ChatIRSeenTracker` 单元测试。
 *
 * 覆盖：
 * 1. track + countConsecutiveAgentMessages 的基本反 loop 语义
 * 2. 人类发言后 agent 计数归零
 * 3. hasAnotherAgentRepliedAfter 的语义（trigger 后、非自己、是 agent）
 * 4. trigger 未观察到时返回 false
 * 5. maxPerThread 修剪
 * 6. IdentityRegistry fallback 判断
 */
import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChatIRSeenTracker } from './seen-tracker.js';
import { IdentityRegistry } from './runtime/identity-registry.js';

const SELF = 'agent:kuroneko';
const OTHER_AGENT = 'agent:gpt';
const HUMAN = 'human:alice';

function makeTracker(maxPerThread = 100) {
  return new ChatIRSeenTracker({ selfAgentSid: SELF, maxPerThread });
}

describe('ChatIRSeenTracker.countConsecutiveAgentMessages', () => {
  it('空线程返回 0', () => {
    const t = makeTracker();
    expect(t.countConsecutiveAgentMessages('th1')).toBe(0);
  });

  it('全是 agent 时返回全长', () => {
    const t = makeTracker();
    t.track('th1', { message_id: 'm1', sender_sid: SELF });
    t.track('th1', { message_id: 'm2', sender_sid: OTHER_AGENT });
    t.track('th1', { message_id: 'm3', sender_sid: SELF });
    expect(t.countConsecutiveAgentMessages('th1')).toBe(3);
  });

  it('人类发言后归零，再 agent 重新计数', () => {
    const t = makeTracker();
    t.track('th1', { message_id: 'a1', sender_sid: SELF });
    t.track('th1', { message_id: 'a2', sender_sid: OTHER_AGENT });
    t.track('th1', { message_id: 'h1', sender_sid: HUMAN });
    t.track('th1', { message_id: 'a3', sender_sid: SELF });
    expect(t.countConsecutiveAgentMessages('th1')).toBe(1);
  });

  it('末尾是人类时返回 0（即使中间有 agent）', () => {
    const t = makeTracker();
    t.track('th1', { message_id: 'a1', sender_sid: SELF });
    t.track('th1', { message_id: 'h1', sender_sid: HUMAN });
    expect(t.countConsecutiveAgentMessages('th1')).toBe(0);
  });

  it('线程之间隔离', () => {
    const t = makeTracker();
    t.track('th1', { message_id: 'a1', sender_sid: SELF });
    t.track('th2', { message_id: 'h1', sender_sid: HUMAN });
    expect(t.countConsecutiveAgentMessages('th1')).toBe(1);
    expect(t.countConsecutiveAgentMessages('th2')).toBe(0);
  });
});

describe('ChatIRSeenTracker.hasAnotherAgentRepliedAfter', () => {
  it('trigger 后有别的 agent 发言 → true', () => {
    const t = makeTracker();
    t.track('th1', { message_id: 'h1', sender_sid: HUMAN });
    t.track('th1', { message_id: 'trigger', sender_sid: HUMAN });
    t.track('th1', { message_id: 'a1', sender_sid: OTHER_AGENT });
    expect(t.hasAnotherAgentRepliedAfter('th1', 'trigger')).toBe(true);
  });

  it('trigger 后只有自己发言 → false', () => {
    const t = makeTracker();
    t.track('th1', { message_id: 'trigger', sender_sid: HUMAN });
    t.track('th1', { message_id: 'self', sender_sid: SELF });
    expect(t.hasAnotherAgentRepliedAfter('th1', 'trigger')).toBe(false);
  });

  it('trigger 后只有人类发言 → false', () => {
    const t = makeTracker();
    t.track('th1', { message_id: 'trigger', sender_sid: HUMAN });
    t.track('th1', { message_id: 'h2', sender_sid: HUMAN });
    expect(t.hasAnotherAgentRepliedAfter('th1', 'trigger')).toBe(false);
  });

  it('trigger 未观察到 → false（视为无信息）', () => {
    const t = makeTracker();
    t.track('th1', { message_id: 'a1', sender_sid: OTHER_AGENT });
    expect(t.hasAnotherAgentRepliedAfter('th1', 'not-seen')).toBe(false);
  });

  it('trigger 之前的 agent 不影响判断', () => {
    const t = makeTracker();
    t.track('th1', { message_id: 'a0', sender_sid: OTHER_AGENT });
    t.track('th1', { message_id: 'trigger', sender_sid: HUMAN });
    t.track('th1', { message_id: 'self', sender_sid: SELF });
    expect(t.hasAnotherAgentRepliedAfter('th1', 'trigger')).toBe(false);
  });
});

describe('ChatIRSeenTracker.track', () => {
  it('超出 maxPerThread 丢弃最旧', () => {
    const t = makeTracker(3);
    t.track('th1', { message_id: 'old-human', sender_sid: HUMAN });
    t.track('th1', { message_id: 'a1', sender_sid: SELF });
    t.track('th1', { message_id: 'a2', sender_sid: SELF });
    t.track('th1', { message_id: 'a3', sender_sid: SELF });
    expect(t.countConsecutiveAgentMessages('th1')).toBe(3);
  });

  it('reset() 清空所有缓存', () => {
    const t = makeTracker();
    t.track('th1', { message_id: 'a1', sender_sid: SELF });
    expect(t.countConsecutiveAgentMessages('th1')).toBe(1);
    t.reset();
    expect(t.countConsecutiveAgentMessages('th1')).toBe(0);
  });
});

describe('ChatIRSeenTracker with IdentityRegistry fallback', () => {
  it('非标准前缀 SID 但 registry.kind=agent → 仍识别为 agent', () => {
    const regPath = path.join(
      tmpdir(),
      `chat-ir-tracker-test-${Date.now()}-${Math.random()}.json`,
    );
    const registry = new IdentityRegistry(regPath);
    const customSid = 'idp:abc';
    registry.upsert({
      schema: 'identity.v1',
      sid: customSid,
      kind: 'agent',
      display_name: 'custom-agent',
      aliases: [],
      roles_in_tenant: [],
      bindings: [],
      updated_at: new Date().toISOString(),
    });

    const t = new ChatIRSeenTracker({
      selfAgentSid: SELF,
      identityRegistry: registry,
    });
    t.track('th1', { message_id: 'm1', sender_sid: customSid });
    expect(t.countConsecutiveAgentMessages('th1')).toBe(1);
  });
});

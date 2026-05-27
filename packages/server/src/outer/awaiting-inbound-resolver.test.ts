/**
 * @see doc/structurizr/INNER-BRAIN-AWAITING-LIFECYCLE.md §5.2
 * @see doc/todo/inner-brain-awaiting-lifecycle.md P0
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addPending, readPendings } from '../openkuroneko/pendings/index.js';
import type { ImInboundEvent } from './outer-brain.js';
import { InnerBrainRegistry, type TaskRecord } from './inner-brain-registry.js';
import {
  inboundMessageText,
  isHumanSender,
  resolveAwaitingInboundFromIm,
} from './awaiting-inbound-resolver.js';

const THREAD = 'thread:awaiting-lab';

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'awaiting-in-'));
}

function mkWorkDir(root: string, suffix: string): string {
  const workDir = path.join(root, suffix);
  fs.mkdirSync(path.join(workDir, '.brain'), { recursive: true });
  return workDir;
}

function humanInbound(text: string, threadId = THREAD): ImInboundEvent {
  return {
    threadId,
    senderSid: 'human:alice',
    message: {
      message_id: `msg-${Date.now()}`,
      parts: [{ type: 'text', text }],
    },
    participantSids: ['human:alice', 'agent:kuroneko'],
  };
}

function registerAwaiting(
  reg: InnerBrainRegistry,
  workDir: string,
  instanceId: string,
  threadId = THREAD,
): void {
  const record: TaskRecord = {
    instanceId,
    workspaceId: `task-${instanceId}`,
    workDir,
    goal: 'test',
    originUser: 'human:alice',
    originThread: threadId,
    status: 'AWAITING',
    startedAt: new Date().toISOString(),
  };
  reg.register(record);
}

describe('awaiting-inbound-resolver helpers', () => {
  it('isHumanSender distinguishes human vs agent', () => {
    expect(isHumanSender('human:alice')).toBe(true);
    expect(isHumanSender('agent:kuroneko')).toBe(false);
    expect(isHumanSender('idp:agent:kuroneko')).toBe(false);
  });

  it('inboundMessageText joins text parts', () => {
    const text = inboundMessageText(
      humanInbound('  hello\nworld  '),
    );
    expect(text).toBe('hello\nworld');
  });
});

describe('resolveAwaitingInboundFromIm', () => {
  let root: string;
  let reg: InnerBrainRegistry;

  beforeEach(() => {
    root = makeRoot();
    reg = new InnerBrainRegistry(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('single AWAITING on thread: human reply resolves latest pending ask_user', () => {
    const workDir = mkWorkDir(root, 'one');
    const brainDir = path.join(workDir, '.brain');
    const older = addPending(brainDir, {
      kind: 'ask_user',
      spec: { prompt: 'old q' },
      deadline: new Date(Date.now() + 3600_000).toISOString(),
    });
    addPending(brainDir, {
      kind: 'ask_user',
      spec: { prompt: 'current q' },
      deadline: new Date(Date.now() + 3600_000).toISOString(),
    });
    registerAwaiting(reg, workDir, 'ib-single-1');

    const out = resolveAwaitingInboundFromIm(reg, humanInbound('SUB=abc'));

    expect(out.resolved).toBe(true);
    expect(out.instanceId).toBe('ib-single-1');
    const items = readPendings(brainDir);
    const latest = items.find((p) => p.id !== older.id && p.kind === 'ask_user');
    expect(latest?.status).toBe('resolved');
    expect((latest?.result as { reply?: string })?.reply).toBe('SUB=abc');
  });

  it('agent sender → no resolve', () => {
    const workDir = mkWorkDir(root, 'agent-no');
    addPending(path.join(workDir, '.brain'), {
      kind: 'ask_user',
      spec: { prompt: 'q' },
    });
    registerAwaiting(reg, workDir, 'ib-agent-1');

    const out = resolveAwaitingInboundFromIm(reg, {
      ...humanInbound('hi'),
      senderSid: 'agent:other',
    });

    expect(out.resolved).toBe(false);
    expect(out.reason).toMatch(/human|agent/i);
  });

  it('multiple AWAITING on same thread without instance_id → no auto resolve', () => {
    const w1 = mkWorkDir(root, 'm1');
    const w2 = mkWorkDir(root, 'm2');
    addPending(path.join(w1, '.brain'), { kind: 'ask_user', spec: { prompt: 'q1' } });
    addPending(path.join(w2, '.brain'), { kind: 'ask_user', spec: { prompt: 'q2' } });
    registerAwaiting(reg, w1, 'ib-m1');
    registerAwaiting(reg, w2, 'ib-m2');

    const out = resolveAwaitingInboundFromIm(reg, humanInbound('ambiguous'));

    expect(out.resolved).toBe(false);
    expect(out.reason).toMatch(/ambiguous|multiple|disambigu/i);
  });

  it('multiple AWAITING: body contains instance_id → resolve matching only', () => {
    const w1 = mkWorkDir(root, 'd1');
    const w2 = mkWorkDir(root, 'd2');
    addPending(path.join(w1, '.brain'), { kind: 'ask_user', spec: { prompt: 'q1' } });
    addPending(path.join(w2, '.brain'), { kind: 'ask_user', spec: { prompt: 'q2' } });
    registerAwaiting(reg, w1, 'ib-target');
    registerAwaiting(reg, w2, 'ib-other');

    const out = resolveAwaitingInboundFromIm(
      reg,
      humanInbound('for ib-target: cookie here'),
    );

    expect(out.resolved).toBe(true);
    expect(out.instanceId).toBe('ib-target');
    const otherPending = readPendings(path.join(w2, '.brain'))[0];
    expect(otherPending?.status).toBe('pending');
  });

  it('[NEW_GOAL] prefix → no resolve', () => {
    const workDir = mkWorkDir(root, 'new-goal');
    addPending(path.join(workDir, '.brain'), { kind: 'ask_user', spec: { prompt: 'q' } });
    registerAwaiting(reg, workDir, 'ib-ng');

    const out = resolveAwaitingInboundFromIm(reg, humanInbound('[NEW_GOAL] 做别的'));

    expect(out.resolved).toBe(false);
    expect(out.reason).toMatch(/new_goal|goal/i);
  });

  it('no AWAITING on thread → no resolve', () => {
    const out = resolveAwaitingInboundFromIm(reg, humanInbound('hello', 'thread:empty'));
    expect(out.resolved).toBe(false);
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMAdapter, Message } from '../adapter/index.js';
import { BrainFS } from '../brain/index.js';
import type { Logger } from '../logger/index.js';
import { createToolRegistry } from '../tools/index.js';
import { runExecutor } from './executor.js';

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kuroneko-executor-'));
}

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

describe('runExecutor self-upgrade loop', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('injects pending capability gaps into the executor prompt', async () => {
    const workDir = makeTmp();
    roots.push(workDir);

    const brain = new BrainFS(workDir);
    brain.writeMilestones('[M1] [Active] 补齐自升级闭环 — 让能力缺口可被下一轮自动消费');
    brain.appendConstraint('[红线] 不要假装缺口已解决');
    brain.appendKnowledge('[事实] capability gaps 目前只记录不消费');
    brain.writeEnvironment('workspace is clean');

    const activeMilestone = brain.getActiveMilestone();
    expect(activeMilestone).not.toBeNull();

    let capturedSystem = '';
    let capturedUser = '';
    const llm: LLMAdapter = {
      chat: vi.fn(async (systemPrompt: string, messages: Message[]) => {
        capturedSystem = systemPrompt;
        capturedUser = String(messages[0]?.content ?? '');
        return { content: 'done' };
      }),
    };

    await runExecutor(
      brain,
      activeMilestone!,
      workDir,
      createToolRegistry([]),
      llm,
      noopLogger,
      {
        pendingCapabilityGaps: [
          {
            gap: 'Missing capability gap feedback loop',
            reason: 'Recorded gaps are never surfaced to the next executor round',
            ts: '2026-05-12T12:00:00.000Z',
          },
        ],
        selfUpdate: {
          repoRoot: 'D:/kuroneko',
          repoScope: 'repo_root',
          verifyCommands: ['npm run build', 'npm test -- src/openkuroneko/controller/executor.test.ts'],
          status: 'applying',
          pendingMutationCount: 2,
        },
      },
    );

    expect(capturedSystem).toContain('capability_gap_handler(action="resolve"');
    expect(capturedSystem).toContain('capability_gap_handler(action="record"');
    expect(capturedUser).toContain('待解决能力缺口（自升级待办）');
    expect(capturedUser).toContain('Missing capability gap feedback loop');
    expect(capturedUser).toContain('Recorded gaps are never surfaced');
    expect(capturedUser).toContain('自我更新会话（受控更新）');
    expect(capturedUser).toContain('整个 repoRoot');
    expect(capturedUser).toContain('verify_self_update');
    expect(capturedUser).toContain('rollback_self_update');
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { LLMAdapter } from '../openkuroneko/adapter/index.js';
import { createMemoryStore } from '../openkuroneko/inner-brain/memory-store.js';
import { createLogger } from '../openkuroneko/logger/index.js';
import { createToolRegistry } from '../openkuroneko/tools/index.js';
import { PLAY_COMPACT_SYSTEM } from './play-compact.js';
import { buildPlaySystemPrompt, buildPlayUserText, runPlaySession } from './play-loop.js';

describe('play loop', () => {
  it('keeps the opening turn to the seed when nothing has been remembered', () => {
    expect(buildPlayUserText('Begin.', [])).toBe('Begin.');
    expect(buildPlayUserText(undefined, [])).toBe('Begin.');
    expect(buildPlayUserText('Begin.', ['桌上有一根红白线'])).toBe(
      'Begin.\n\n- 桌上有一根红白线',
    );
    expect(buildPlaySystemPrompt('/tmp/desk')).toBe('工作目录：/tmp/desk');
    expect(buildPlaySystemPrompt('/tmp/desk')).not.toMatch(/验收|里程碑|report_done|好奇/);
  });

  it('runs tools until the model stops calling them, without a designer graph', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'play-loop-'));
    const workDir = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workDir, '.brain'), { recursive: true });
    fs.writeFileSync(path.join(workDir, '.brain', 'goal.md'), 'Begin.\n', 'utf8');
    const memory = createMemoryStore(workDir);
    let calls = 0;
    const llm: LLMAdapter = {
      async chat(systemPrompt, messages, tools) {
        if (systemPrompt === PLAY_COMPACT_SYSTEM || !tools?.length) {
          expect(String(messages[0]?.content ?? '')).toContain('ping');
          return { content: '叫过一次 ping，返回 pong。' };
        }
        calls += 1;
        expect(systemPrompt).toBe(`工作目录：${workDir}`);
        expect(messages[0]?.content).toBe('Begin.');
        if (calls === 1) {
          return { content: '', toolCalls: [{ id: 'c1', name: 'ping', args: { n: 1 } }] };
        }
        return { content: '好' };
      },
    };
    const toolRegistry = createToolRegistry([
      {
        name: 'ping',
        description: 'ping',
        parameters: { n: { type: 'number', description: 'n' } },
        async call() {
          return { ok: true, output: 'pong' };
        },
      },
    ]);
    const result = await runPlaySession({
      workspaceId: 'play-test',
      workDir,
      maxTicks: 5,
      llm,
      toolRegistry,
      logger: createLogger('play-test', path.join(workDir, '.run', 'pi-mono')),
      memory,
    });
    expect(result).toMatchObject({ ok: true, ticks: 2, stoppedBy: 'idle' });
    const transcript = fs.readFileSync(path.join(workDir, '.run', 'pi-mono', 'play.jsonl'), 'utf8');
    expect(transcript).toContain('"name":"ping"');
    expect(transcript).toContain('pong');
    expect(fs.existsSync(path.join(workDir, '.brain', 'dyflow-state.json'))).toBe(false);
    expect(fs.readFileSync(path.join(workDir, '.brain', 'play-context.md'), 'utf8')).toContain('ping');
  });
});

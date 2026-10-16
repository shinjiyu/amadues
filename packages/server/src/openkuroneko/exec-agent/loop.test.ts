import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { AssistantMessage, Model } from '@earendil-works/pi-ai';

import { askJev } from './jev.js';
import {
  applyAgentSeed,
  buildReflectPrompt,
  collectArtifact,
  execCommand,
  findVariantConflict,
  MAX_REFLECT_TOOL_CALLS,
  REFLECT_PROMPT,
  runExecAgent,
} from './loop.js';

const model = { id: 'fake', api: 'openai-completions' } as Model<any>;

function assistant(partial: Pick<AssistantMessage, 'content' | 'stopReason'>): AssistantMessage {
  return {
    role: 'assistant',
    content: partial.content,
    api: 'openai-completions',
    provider: 'openai',
    model: 'fake',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: partial.stopReason,
    timestamp: 1,
  };
}

describe('execAgent', () => {
  it('keeps the tool result in the next model call and stops when exec is not called', async () => {
    const seenRoles: string[][] = [];
    let toolNames: string[] = [];
    const commands: string[] = [];
    let n = 0;
    const result = await runExecAgent({
      model,
      task: 'say hi',
      cwd: os.tmpdir(),
      complete: async (_model, context) => {
        seenRoles.push(context.messages.map(message => message.role));
        toolNames = (context.tools ?? []).map(tool => tool.name);
        n += 1;
        if (n === 1) {
          return assistant({
            stopReason: 'toolUse',
            content: [{ type: 'toolCall', id: 'c1', name: 'exec', arguments: { command: 'echo hi' } }],
          });
        }
        const toolMessage = context.messages[2];
        expect(toolMessage && 'isError' in toolMessage ? toolMessage.isError : true).toBe(false);
        return assistant({
          stopReason: 'stop',
          content: [{ type: 'text', text: 'done' }],
        });
      },
      exec: command => {
        commands.push(command);
        return { ok: true, output: 'hi\n' };
      },
    });

    expect(commands).toEqual(['echo hi']);
    expect(toolNames).toEqual(['exec']);
    expect(seenRoles[1]).toEqual(['user', 'assistant', 'toolResult']);
    expect(result.stopReason).toBe('no-tool-call');
    expect(result.messages.map(message => message.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
      'assistant',
    ]);
  });

  it('stops immediately when the model does not call a tool', async () => {
    let execs = 0;
    const result = await runExecAgent({
      model,
      task: 'nothing',
      cwd: os.tmpdir(),
      complete: async () =>
        assistant({ stopReason: 'stop', content: [{ type: 'text', text: 'no work' }] }),
      exec: () => {
        execs += 1;
        return { ok: true, output: '' };
      },
    });
    expect(execs).toBe(0);
    expect(result.stopReason).toBe('no-tool-call');
  });

  it('reports an unknown tool and still continues the loop', async () => {
    let n = 0;
    const result = await runExecAgent({
      model,
      task: 'nope',
      cwd: os.tmpdir(),
      complete: async () => {
        n += 1;
        if (n === 1) {
          return assistant({
            stopReason: 'toolUse',
            content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: {} }],
          });
        }
        return assistant({ stopReason: 'stop', content: [{ type: 'text', text: 'ok' }] });
      },
      exec: () => ({ ok: true, output: 'should not run' }),
    });
    const toolMessage = result.messages[2];
    expect(toolMessage?.role).toBe('toolResult');
    expect(toolMessage && 'isError' in toolMessage ? toolMessage.isError : false).toBe(true);
    expect(result.stopReason).toBe('no-tool-call');
  });

  it('feeds a model error back into the transcript and continues', async () => {
    let n = 0;
    let sawError = false;
    const result = await runExecAgent({
      model,
      task: 'keep going',
      cwd: os.tmpdir(),
      complete: async (_model, context) => {
        n += 1;
        if (n === 1) {
          return {
            ...assistant({ stopReason: 'error', content: [] }),
            errorMessage: 'context length exceeded',
          };
        }
        sawError = context.messages.some(
          message => message.role === 'user' && message.content === 'context length exceeded',
        );
        return assistant({ stopReason: 'stop', content: [{ type: 'text', text: 'ok' }] });
      },
    });
    expect(sawError).toBe(true);
    expect(result.stopReason).toBe('no-tool-call');
    expect(result.rounds).toBe(0);
  });

  it('runs a command in the given directory', () => {
    const cwd = os.tmpdir();
    const ran = execCommand('pwd', cwd);
    expect(ran.ok).toBe(true);
    expect(fs.realpathSync(ran.output.trim())).toBe(fs.realpathSync(cwd));
  });

  it('runs another round when JEV says the artifact is not done', async () => {
    const judged: string[] = [];
    let n = 0;
    const result = await runExecAgent({
      model,
      task: 'add a marker',
      cwd: os.tmpdir(),
      maxRounds: 2,
      complete: async () => {
        n += 1;
        return assistant({
          stopReason: 'stop',
          content: [{ type: 'text', text: n === 1 ? 'first try' : 'second try' }],
        });
      },
      judge: async ({ task, artifact }) => {
        judged.push(`${task}\n${artifact}`);
        return { done: judged.length === 2, choice: judged.length === 2 ? 'yes' : 'no' };
      },
    });
    expect(judged).toHaveLength(2);
    expect(judged[0]).toContain('add a marker');
    expect(judged[0]).toContain('first try');
    expect(result.stopReason).toBe('complete');
    expect(result.rounds).toBe(2);
    expect(result.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('stops incomplete when every round is rejected', async () => {
    const result = await runExecAgent({
      model,
      task: 'never',
      cwd: os.tmpdir(),
      maxRounds: 1,
      complete: async () => assistant({ stopReason: 'stop', content: [{ type: 'text', text: 'no' }] }),
      judge: async () => ({ done: false, choice: 'no' }),
    });
    expect(result.stopReason).toBe('incomplete');
    expect(result.rounds).toBe(1);
  });

  it('sends the task and artifact to JEV as one yes/no question', async () => {
    let body = '';
    const verdict = await askJev('the task', 'the diff', {
      token: 'test-key',
      fetch: async (_url, init) => {
        body = String(init?.body ?? '');
        return new Response(JSON.stringify({ answers: { done: { choice: 'yes' } } }), { status: 200 });
      },
    });
    const parsed = JSON.parse(body) as { state: string; questions: { done: { type: string } } };
    expect(parsed.state).toContain('the task');
    expect(parsed.state).toContain('the diff');
    expect(parsed.questions.done.type).toBe('choice');
    expect(verdict).toEqual({ done: true, choice: 'yes' });
  });

  it('uses the git diff as the artifact', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-agent-'));
    execCommand('git init && git config user.email a@b.c && git config user.name a && echo base > f.txt && git add f.txt && git commit -m base && echo next > f.txt', cwd);
    const artifact = collectArtifact(cwd, 'fallback');
    expect(artifact).toContain('next');
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('reflects after an act failure with rules only — no create_tool', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-agent-reflect-'));
    const reflectToolNames: string[][] = [];
    const reflectRoles: string[][] = [];
    const result = await runExecAgent({
      model,
      task: 'run tests',
      cwd,
      complete: async (_model, context) => {
        const names = (context.tools ?? []).map(tool => tool.name);
        const reflecting = names.includes('upsert_rule') && !names.includes('exec');
        if (reflecting) {
          expect(names.includes('create_tool')).toBe(false);
          expect(context.systemPrompt).toContain(REFLECT_PROMPT);
          expect(context.systemPrompt).toContain('cannot create or change actor tools');
          reflectToolNames.push(names);
          reflectRoles.push(context.messages.map(message => message.role));
          const wrote = context.messages.some(
            message => message.role === 'toolResult' && message.toolName === 'upsert_rule',
          );
          if (!wrote) {
            return assistant({
              stopReason: 'toolUse',
              content: [{
                type: 'toolCall',
                id: 'r1',
                name: 'upsert_rule',
                arguments: {
                  id: 'pytest_first',
                  body: 'Prefer a focused pytest -k after a full-suite failure.',
                },
              }],
            });
          }
          return assistant({ stopReason: 'stop', content: [{ type: 'text', text: 'saved' }] });
        }
        const execs = context.messages.filter(
          message => message.role === 'toolResult' && message.toolName === 'exec',
        ).length;
        if (execs === 0) {
          return assistant({
            stopReason: 'toolUse',
            content: [{ type: 'toolCall', id: 'a1', name: 'exec', arguments: { command: 'python3 -m pytest' } }],
          });
        }
        expect(names).toEqual(['exec']);
        return assistant({ stopReason: 'stop', content: [{ type: 'text', text: 'done' }] });
      },
      exec: command => {
        return command.includes('pytest')
          ? { ok: false, output: 'collection error' }
          : { ok: true, output: 'ok' };
      },
    });
    expect(reflectRoles[0]).toEqual(['user', 'assistant', 'toolResult']);
    expect(reflectToolNames[0]).not.toContain('create_tool');
    expect(result.registeredTools).toEqual([]);
    expect(result.rules).toEqual(['pytest_first']);
    expect(result.messages.some(message => message.role === 'toolResult' && message.toolName === 'create_tool')).toBe(false);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('reflects once after ten consecutive act successes', async () => {
    let reflects = 0;
    let successesSeen = 0;
    const result = await runExecAgent({
      model,
      task: 'repeat',
      cwd: os.tmpdir(),
      complete: async (_model, context) => {
        const names = (context.tools ?? []).map(tool => tool.name);
        if (names.includes('upsert_rule') && !names.includes('exec')) {
          reflects += 1;
          successesSeen = context.messages.filter(message => message.role === 'toolResult').length;
          return assistant({ stopReason: 'stop', content: [{ type: 'text', text: 'nothing to add' }] });
        }
        const done = context.messages.filter(message => message.role === 'toolResult').length;
        if (done < 10) {
          return assistant({
            stopReason: 'toolUse',
            content: [{ type: 'toolCall', id: `a${done}`, name: 'exec', arguments: { command: 'true' } }],
          });
        }
        return assistant({ stopReason: 'stop', content: [{ type: 'text', text: 'done' }] });
      },
      exec: () => ({ ok: true, output: 'ok' }),
    });
    expect(reflects).toBe(1);
    expect(successesSeen).toBe(10);
    expect(result.messages.some(message => message.role === 'assistant' && message.content.some(
      part => part.type === 'text' && part.text === 'nothing to add',
    ))).toBe(false);
  });

  it('resets the success streak when an act fails', async () => {
    let reflects = 0;
    let calls = 0;
    await runExecAgent({
      model,
      task: 'streak',
      cwd: os.tmpdir(),
      complete: async (_model, context) => {
        const names = (context.tools ?? []).map(tool => tool.name);
        if (names.includes('upsert_rule') && !names.includes('exec')) {
          reflects += 1;
          return assistant({ stopReason: 'stop', content: [{ type: 'text', text: 'skip' }] });
        }
        const done = context.messages.filter(message => message.role === 'toolResult').length;
        if (done < 19) {
          return assistant({
            stopReason: 'toolUse',
            content: [{ type: 'toolCall', id: `a${done}`, name: 'exec', arguments: { command: 'true' } }],
          });
        }
        return assistant({ stopReason: 'stop', content: [{ type: 'text', text: 'done' }] });
      },
      exec: () => {
        calls += 1;
        return calls === 10 ? { ok: false, output: 'fail' } : { ok: true, output: 'ok' };
      },
    });
    expect(reflects).toBe(1);
  });

  it('persists reflect rules and skills into the next act system prompt', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-agent-memory-'));
    const actPrompts: string[] = [];
    let phase: 'fail' | 'reflect-write' | 'act-with-memory' | 'reflect-retire' | 'act-after-retire' = 'fail';

    const result = await runExecAgent({
      model,
      task: 'capture scene',
      cwd,
      complete: async (_model, context) => {
        const names = (context.tools ?? []).map(tool => tool.name);
        const reflecting = names.includes('upsert_rule') && !names.includes('exec');
        if (reflecting) {
          if (phase === 'fail') {
            phase = 'reflect-write';
            return assistant({
              stopReason: 'toolUse',
              content: [
                {
                  type: 'toolCall',
                  id: 'r1',
                  name: 'upsert_rule',
                  arguments: {
                    id: 'no_webgl_guess',
                    body: 'Do not treat a flat-color screenshot as a successful WebGL capture.',
                  },
                },
                {
                  type: 'toolCall',
                  id: 'r2',
                  name: 'upsert_skill',
                  arguments: {
                    name: 'screenshot_check',
                    body: '1. Capture.\n2. Check non-flat pixels before claiming success.',
                  },
                },
              ],
            });
          }
          if (phase === 'reflect-write') {
            phase = 'act-with-memory';
            return assistant({ stopReason: 'stop', content: [{ type: 'text', text: 'saved lessons' }] });
          }
          if (phase === 'act-with-memory') {
            phase = 'reflect-retire';
            return assistant({
              stopReason: 'toolUse',
              content: [
                {
                  type: 'toolCall',
                  id: 'r3',
                  name: 'retire_rule',
                  arguments: { id: 'no_webgl_guess' },
                },
                {
                  type: 'toolCall',
                  id: 'r4',
                  name: 'retire_skill',
                  arguments: { name: 'screenshot_check' },
                },
              ],
            });
          }
          phase = 'act-after-retire';
          return assistant({ stopReason: 'stop', content: [{ type: 'text', text: 'retired' }] });
        }

        actPrompts.push(context.systemPrompt ?? '');
        if (phase === 'fail') {
          return assistant({
            stopReason: 'toolUse',
            content: [{ type: 'toolCall', id: 'a1', name: 'exec', arguments: { command: 'false' } }],
          });
        }
        if (phase === 'act-with-memory') {
          expect(context.systemPrompt).toContain('### rule:no_webgl_guess');
          expect(context.systemPrompt).toContain('flat-color screenshot');
          expect(context.systemPrompt).toContain('### skill:screenshot_check');
          expect(context.systemPrompt).toContain('Check non-flat pixels');
          expect(fs.existsSync(path.join(cwd, '.agent', 'rules', 'no_webgl_guess.md'))).toBe(true);
          expect(fs.existsSync(path.join(cwd, '.agent', 'skills', 'screenshot_check', 'SKILL.md'))).toBe(true);
          return assistant({
            stopReason: 'toolUse',
            content: [{ type: 'toolCall', id: 'a2', name: 'exec', arguments: { command: 'false' } }],
          });
        }
        expect(context.systemPrompt ?? '').not.toContain('rule:no_webgl_guess');
        expect(context.systemPrompt ?? '').not.toContain('skill:screenshot_check');
        return assistant({ stopReason: 'stop', content: [{ type: 'text', text: 'done' }] });
      },
      exec: () => ({ ok: false, output: 'capture failed' }),
    });

    expect(actPrompts.some(prompt => prompt.includes('rule:no_webgl_guess'))).toBe(true);
    expect(actPrompts.some(prompt => prompt.includes('skill:screenshot_check'))).toBe(true);
    expect(result.rules).toEqual([]);
    expect(result.skills).toEqual([]);
    expect(fs.existsSync(path.join(cwd, '.agent', 'rules', 'no_webgl_guess.md'))).toBe(false);
    expect(fs.existsSync(path.join(cwd, '.agent', 'skills', 'screenshot_check', 'SKILL.md'))).toBe(false);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('loads seeded tools from .agent/tools.json and never exposes create_tool', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-agent-seed-'));
    fs.mkdirSync(path.join(cwd, '.agent'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.agent', 'tools.json'),
      JSON.stringify([{
        name: 'pytest_k',
        description: 'Run pytest for one keyword',
        command: 'python3 -m pytest -k "$k"',
        parameters: { k: 'pytest keyword expression' },
      }]),
      'utf8',
    );
    const commands: string[] = [];
    let sawReflectCreate = false;

    const result = await runExecAgent({
      model,
      task: 'seeded',
      cwd,
      complete: async (_model, context) => {
        const names = (context.tools ?? []).map(tool => tool.name);
        if (names.includes('create_tool')) sawReflectCreate = true;
        if (names.includes('upsert_rule') && !names.includes('exec')) {
          return assistant({ stopReason: 'stop', content: [{ type: 'text', text: 'no invent' }] });
        }
        if (!context.messages.some(m => m.role === 'toolResult' && m.toolName === 'pytest_k')) {
          expect(names).toEqual(['exec', 'pytest_k']);
          return assistant({
            stopReason: 'toolUse',
            content: [{ type: 'toolCall', id: 'a1', name: 'pytest_k', arguments: { k: 'TestNew' } }],
          });
        }
        return assistant({ stopReason: 'stop', content: [{ type: 'text', text: 'done' }] });
      },
      exec: command => {
        commands.push(command);
        return { ok: true, output: 'passed' };
      },
    });

    expect(sawReflectCreate).toBe(false);
    expect(commands[0]).toContain("export k='TestNew'");
    expect(result.registeredTools).toEqual(['pytest_k']);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('applyAgentSeed copies rules skills and tools into cwd', () => {
    const seed = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-seed-src-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-seed-dst-'));
    fs.mkdirSync(path.join(seed, 'rules'), { recursive: true });
    fs.mkdirSync(path.join(seed, 'skills', 'dl'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'rules', 'no_unzip_early.md'), 'Wait for zip EOF.\n');
    fs.writeFileSync(path.join(seed, 'skills', 'dl', 'SKILL.md'), '1. curl\n2. wait size\n');
    fs.writeFileSync(path.join(seed, 'tools.json'), '[]');
    applyAgentSeed(seed, cwd);
    expect(fs.readFileSync(path.join(cwd, '.agent', 'rules', 'no_unzip_early.md'), 'utf8')).toContain('EOF');
    expect(fs.existsSync(path.join(cwd, '.agent', 'skills', 'dl', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(cwd, '.agent', 'tools.json'))).toBe(true);
    fs.rmSync(seed, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('buildReflectPrompt is static and forbids create_tool', () => {
    expect(findVariantConflict('see_image2', ['see_image'])).toBe('see_image');
    const prompt = buildReflectPrompt([{ name: 'see_image', uses: 0, description: 'x' }]);
    expect(prompt).toBe(REFLECT_PROMPT);
    expect(prompt).toContain('cannot create or change actor tools');
    expect(prompt).not.toContain('create_tool');
    expect(prompt).not.toContain('Current actor tools');
  });

  it('ends a reflect session after the tool-call budget even if the model keeps calling', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-agent-budget-'));
    let reflectTurns = 0;
    let actAfterReflect = 0;
    const result = await runExecAgent({
      model,
      task: 'budget',
      cwd,
      complete: async (_model, context) => {
        const names = (context.tools ?? []).map(tool => tool.name);
        if (names.includes('upsert_rule') && !names.includes('exec')) {
          reflectTurns += 1;
          return assistant({
            stopReason: 'toolUse',
            content: [{
              type: 'toolCall',
              id: `r${reflectTurns}`,
              name: 'upsert_rule',
              arguments: { id: `r${reflectTurns}`, body: `lesson ${reflectTurns}` },
            }],
          });
        }
        if (reflectTurns === 0) {
          return assistant({
            stopReason: 'toolUse',
            content: [{ type: 'toolCall', id: 'a0', name: 'exec', arguments: { command: 'false' } }],
          });
        }
        actAfterReflect += 1;
        return assistant({ stopReason: 'stop', content: [{ type: 'text', text: 'back to act' }] });
      },
      exec: () => ({ ok: false, output: 'fail' }),
    });
    expect(reflectTurns).toBeLessThanOrEqual(MAX_REFLECT_TOOL_CALLS);
    expect(reflectTurns).toBeGreaterThan(0);
    expect(actAfterReflect).toBe(1);
    expect(result.rules.length).toBe(reflectTurns);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

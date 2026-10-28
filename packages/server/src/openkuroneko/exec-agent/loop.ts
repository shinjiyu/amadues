/**
 * 最小 agent：act 调 exec（±跑前种子工具）；失败或连续成功 10 次时 reflect。
 * Reflect **无 create_tool**，只沉淀 rules / skills。工具仅 `.agent/tools.json` 种子。
 * 见 doc/structurizr/EXEC-AGENT.md。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  Type,
  createModels,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type Tool,
  type ToolResultMessage,
} from '@earendil-works/pi-ai';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { zaiCodingCnProvider } from '@earendil-works/pi-ai/providers/zai-coding-cn';

import { askJev, type JevVerdict } from './jev.js';

export const EXEC_TOOL = {
  name: 'exec',
  description: 'Run one shell command. Each call starts a new shell in the working directory.',
  parameters: Type.Object({
    command: Type.String({ description: 'The command to run' }),
  }),
};

const SYSTEM_PROMPT = [
  'You solve the task by calling tools.',
  'If a seeded tool fits, prefer it over a long exec script — shorter calls cost fewer tokens.',
  'Keep arguments short. When finished, reply with text and do not call a tool.',
].join('\n');

export const MAX_TOOL_DESCRIPTION_CHARS = 120;
/** 单次 reflect() 内 complete 调用次数上限（含本轮）。 */
export const MAX_REFLECT_LLM_TURNS = 4;
/** 单次 reflect() 内 Reflect 工具调用总次数上限。 */
export const MAX_REFLECT_TOOL_CALLS = 6;

const REFLECT_PROMPT = [
  'You share the actor transcript, but this turn is only for reflection.',
  'Your messages are not kept. Persist what matters with tools:',
  '- upsert_rule: short standing constraint or lesson (do / do not).',
  '- upsert_skill: reusable how-to for a recurring procedure.',
  '- retire_rule / retire_skill: remove a bad entry.',
  'You cannot create or change actor tools. Tool vocabulary is fixed for this run (seed only).',
  'Prefer a rule or skill when the lesson is procedural.',
  `Budget: at most ${MAX_REFLECT_LLM_TURNS} reflect model turns and ${MAX_REFLECT_TOOL_CALLS} reflect tool calls; then reflection ends and the actor continues.`,
  'If nothing is worth saving, reply with text and do not call a tool.',
].join('\n');

export { REFLECT_PROMPT };

/** @deprecated alias — reflect prompt is now static (no tool catalog). */
export function buildReflectPrompt(_catalog?: ToolCatalogEntry[]): string {
  return REFLECT_PROMPT;
}

export type ToolCatalogEntry = { name: string; uses: number; description: string };

const RESERVED_TOOL_NAMES = new Set([
  'exec',
  'create_tool',
  'upsert_rule',
  'upsert_skill',
  'retire_rule',
  'retire_skill',
]);

const UPSERT_RULE: Tool = {
  name: 'upsert_rule',
  description: 'Create or replace a short standing rule. It is saved under .agent/rules and injected into later actor system prompts.',
  parameters: Type.Object({
    id: Type.String({ description: 'Rule id. An identifier.' }),
    body: Type.String({ description: 'The rule text. Keep it short and actionable.' }),
  }),
};

const UPSERT_SKILL: Tool = {
  name: 'upsert_skill',
  description: 'Create or replace a reusable skill playbook. It is saved under .agent/skills/<name>/SKILL.md and injected into later actor system prompts.',
  parameters: Type.Object({
    name: Type.String({ description: 'Skill name. An identifier.' }),
    body: Type.String({ description: 'How-to steps the actor should follow for this procedure.' }),
  }),
};

const RETIRE_RULE: Tool = {
  name: 'retire_rule',
  description: 'Delete a rule so it no longer appears in the actor system prompt.',
  parameters: Type.Object({
    id: Type.String({ description: 'Rule id to remove.' }),
  }),
};

const RETIRE_SKILL: Tool = {
  name: 'retire_skill',
  description: 'Delete a skill so it no longer appears in the actor system prompt.',
  parameters: Type.Object({
    name: Type.String({ description: 'Skill name to remove.' }),
  }),
};

const REFLECT_TOOLS: Tool[] = [UPSERT_RULE, UPSERT_SKILL, RETIRE_RULE, RETIRE_SKILL];

const ACT_SUCCESS_BEFORE_REFLECT = 10;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type CompleteFn = (model: Model<any>, context: Context) => Promise<AssistantMessage>;

let piModels: ReturnType<typeof createModels> | undefined;

function pi() {
  if (!process.env.ZAI_CODING_CN_API_KEY && process.env.ZHIPU_API_KEY) {
    process.env.ZAI_CODING_CN_API_KEY = process.env.ZHIPU_API_KEY;
  }
  if (!piModels) {
    piModels = createModels();
    piModels.setProvider(zaiCodingCnProvider());
    piModels.setProvider(deepseekProvider());
  }
  return piModels;
}

/** 智谱 GLM-5.3，走 pi-ai 的 zai-coding-cn（OpenAI 兼容）。 */
export function glm53(): Model<any> {
  const model = pi().getModel('zai-coding-cn', 'glm-5.3');
  if (!model) throw new Error('glm-5.3 is not in the pi-ai zai-coding-cn catalog');
  return model;
}

/**
 * DeepSeek V4.1 Flash（pi-ai catalog id: deepseek-flash）。
 * 需要 DEEPSEEK_API_KEY；官方 base https://api.deepseek.com。
 */
export function deepseekFlash(): Model<any> {
  const model = pi().getModel('deepseek', 'deepseek-flash');
  if (!model) throw new Error('deepseek-flash is not in the pi-ai deepseek catalog');
  return model;
}

/** 汇总 assistant 消息里的 usage（input=未命中缓存；cacheRead=缓存命中）。 */
export function sumMessageUsage(messages: Message[]): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  calls: number;
} {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let totalTokens = 0;
  let calls = 0;
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const usage = (message as { usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      totalTokens?: number;
    } }).usage;
    if (!usage) continue;
    calls += 1;
    input += usage.input ?? 0;
    output += usage.output ?? 0;
    cacheRead += usage.cacheRead ?? 0;
    cacheWrite += usage.cacheWrite ?? 0;
    totalTokens += usage.totalTokens ?? ((usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0));
  }
  return { input, output, cacheRead, cacheWrite, totalTokens, calls };
}

function defaultComplete(model: Model<any>, context: Context): Promise<AssistantMessage> {
  // 1.4 的请求档没有 off。不传 reasoning 时，智谱这条线的 thinking 是关掉的。
  return pi().completeSimple(model, context);
}

export type ExecAgentPhase = 'act' | 'reflect' | 'judge';

export type ExecAgentEvent =
  | { type: 'llm-start'; phase: ExecAgentPhase }
  | { type: 'llm-end'; phase: ExecAgentPhase; stopReason: string }
  | { type: 'reflect-tool'; name: string; ok: boolean }
  | { type: 'act-tool'; name: string; uses: number }
  | { type: 'memory'; registeredTools: string[]; rules: string[]; skills: string[] };

export interface ExecAgentOptions {
  model: Model<any>;
  task: string;
  cwd: string;
  /** 默认 completeSimple。测试注入假实现。 */
  complete?: CompleteFn;
  /** 默认本机 bash。 */
  exec?: (command: string, cwd: string) => { ok: boolean; output: string };
  /**
   * 模型不再调用工具之后的完成判断。正式跑用 askJev。
   * 不传则模型收工即停。
   */
  judge?: (input: { task: string; artifact: string }) => Promise<JevVerdict>;
  /** judge 连续判未完成的轮数上限。不设则一直重跑。 */
  maxRounds?: number;
  /** 失控保护。不设则不按步数停。 */
  maxSteps?: number;
  systemPrompt?: string;
  /** 进度钩子（冒烟页 / 日志）。 */
  onEvent?: (event: ExecAgentEvent) => void;
}

export interface ExecAgentResult {
  messages: Message[];
  stopReason: 'no-tool-call' | 'complete' | 'incomplete' | 'aborted' | 'max-steps';
  rounds: number;
  /** 跑前种子（`.agent/tools.json`）登记的工具名（不含 exec）。运行中不可增删。 */
  registeredTools: string[];
  rules: string[];
  skills: string[];
}

export function execCommand(command: string, cwd: string, timeoutMs = 120_000): { ok: boolean; output: string } {
  const result = spawnSync('bash', ['-lc', command], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) return { ok: false, output: result.error.message };
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { ok: result.status === 0, output };
}

function lastAssistantText(message: AssistantMessage): string {
  return message.content
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n');
}

/** 产物：工作区相对 HEAD 的 diff。没有改动时用模型最后一段文字。 */
export function collectArtifact(cwd: string, fallback: string): string {
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, encoding: 'utf8' });
  if (inside.status !== 0) return fallback || '(no artifact)';
  const diff = spawnSync('git', ['diff', 'HEAD'], { cwd, encoding: 'utf8' });
  const text = (diff.stdout ?? '').trim();
  return text || fallback || '(no artifact)';
}

export function jevJudge(input: { task: string; artifact: string }): Promise<JevVerdict> {
  return askJev(input.task, input.artifact);
}

function toolResult(callId: string, name: string, text: string, isError: boolean): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: callId,
    toolName: name,
    content: [{ type: 'text', text }],
    isError,
    timestamp: Date.now(),
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface RegisteredTool {
  command: string;
  parameters: string[];
}

class AgentMemory {
  readonly rules = new Map<string, string>();
  readonly skills = new Map<string, string>();

  constructor(private readonly cwd: string) {
    this.load();
  }

  private rulesDir(): string {
    return path.join(this.cwd, '.agent', 'rules');
  }

  private skillsDir(): string {
    return path.join(this.cwd, '.agent', 'skills');
  }

  private load(): void {
    const rulesDir = this.rulesDir();
    if (fs.existsSync(rulesDir)) {
      for (const entry of fs.readdirSync(rulesDir)) {
        if (!entry.endsWith('.md')) continue;
        const id = entry.slice(0, -3);
        if (!IDENTIFIER.test(id)) continue;
        this.rules.set(id, fs.readFileSync(path.join(rulesDir, entry), 'utf8'));
      }
    }
    const skillsDir = this.skillsDir();
    if (fs.existsSync(skillsDir)) {
      for (const entry of fs.readdirSync(skillsDir)) {
        if (!IDENTIFIER.test(entry)) continue;
        const file = path.join(skillsDir, entry, 'SKILL.md');
        if (!fs.existsSync(file)) continue;
        this.skills.set(entry, fs.readFileSync(file, 'utf8'));
      }
    }
  }

  upsertRule(id: string, body: string): { ok: true } | { ok: false; error: string } {
    if (!IDENTIFIER.test(id)) return { ok: false, error: `invalid rule id: ${id}` };
    if (!body.trim()) return { ok: false, error: 'rule body is empty' };
    fs.mkdirSync(this.rulesDir(), { recursive: true });
    fs.writeFileSync(path.join(this.rulesDir(), `${id}.md`), body.trimEnd() + '\n', 'utf8');
    this.rules.set(id, body.trimEnd() + '\n');
    return { ok: true };
  }

  upsertSkill(name: string, body: string): { ok: true } | { ok: false; error: string } {
    if (!IDENTIFIER.test(name)) return { ok: false, error: `invalid skill name: ${name}` };
    if (!body.trim()) return { ok: false, error: 'skill body is empty' };
    const dir = path.join(this.skillsDir(), name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), body.trimEnd() + '\n', 'utf8');
    this.skills.set(name, body.trimEnd() + '\n');
    return { ok: true };
  }

  retireRule(id: string): { ok: true } | { ok: false; error: string } {
    if (!IDENTIFIER.test(id)) return { ok: false, error: `invalid rule id: ${id}` };
    if (!this.rules.has(id)) return { ok: false, error: `unknown rule: ${id}` };
    const file = path.join(this.rulesDir(), `${id}.md`);
    if (fs.existsSync(file)) fs.rmSync(file);
    this.rules.delete(id);
    return { ok: true };
  }

  retireSkill(name: string): { ok: true } | { ok: false; error: string } {
    if (!IDENTIFIER.test(name)) return { ok: false, error: `invalid skill name: ${name}` };
    if (!this.skills.has(name)) return { ok: false, error: `unknown skill: ${name}` };
    const dir = path.join(this.skillsDir(), name);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    this.skills.delete(name);
    return { ok: true };
  }

  renderForAct(base: string): string {
    const parts = [base];
    if (this.rules.size > 0) {
      parts.push('Rules (standing constraints from seed / reflection):');
      for (const [id, body] of [...this.rules.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        parts.push(`### rule:${id}\n${body.trim()}`);
      }
    }
    if (this.skills.size > 0) {
      parts.push('Skills (playbooks from seed / reflection):');
      for (const [name, body] of [...this.skills.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        parts.push(`### skill:${name}\n${body.trim()}`);
      }
    }
    return parts.join('\n\n');
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Reject foo2 / foo_v2 / foov2 when foo (or another variant) already exists. */
export function findVariantConflict(name: string, existing: Iterable<string>): string | null {
  for (const other of existing) {
    if (other === name) return other;
    const a = escapeRegExp(other);
    const b = escapeRegExp(name);
    if (new RegExp(`^${a}(_?v?\\d+)$`, 'i').test(name)) return other;
    if (new RegExp(`^${b}(_?v?\\d+)$`, 'i').test(other)) return other;
  }
  return null;
}

function registerSeededTool(
  args: Record<string, unknown>,
  tools: Tool[],
  bodies: Map<string, RegisteredTool>,
): { ok: true; name: string } | { ok: false; error: string } {
  const name = typeof args.name === 'string' ? args.name : '';
  let description = typeof args.description === 'string' ? args.description : '';
  const command = typeof args.command === 'string' ? args.command : '';
  if (!IDENTIFIER.test(name) || RESERVED_TOOL_NAMES.has(name)) {
    return { ok: false, error: `invalid tool name: ${name}` };
  }
  if (bodies.has(name)) return { ok: false, error: `tool already exists: ${name}` };
  const conflict = findVariantConflict(name, bodies.keys());
  if (conflict) {
    return { ok: false, error: `reuse existing tool "${conflict}" instead of variant "${name}"` };
  }
  if (!description.trim()) return { ok: false, error: 'description is empty' };
  if (!command.trim()) return { ok: false, error: 'command is empty' };
  description = description.replace(/\s+/g, ' ').trim().slice(0, MAX_TOOL_DESCRIPTION_CHARS);

  const parameters: Record<string, string> = {};
  if (args.parameters != null) {
    if (typeof args.parameters !== 'object' || Array.isArray(args.parameters)) {
      return { ok: false, error: 'parameters must be an object of argument descriptions' };
    }
    for (const [key, value] of Object.entries(args.parameters as Record<string, unknown>)) {
      if (!IDENTIFIER.test(key)) return { ok: false, error: `invalid parameter: ${key}` };
      const text = typeof value === 'string' ? value : String(value ?? '');
      parameters[key] = text.replace(/\s+/g, ' ').trim().slice(0, 80);
    }
  }

  tools.push({
    name,
    description,
    parameters: Type.Object(Object.fromEntries(
      Object.entries(parameters).map(([key, text]) => [key, Type.String({ description: text })]),
    )),
  });
  bodies.set(name, { command, parameters: Object.keys(parameters) });
  return { ok: true, name };
}

function commandFor(spec: RegisteredTool, args: Record<string, unknown>): string {
  const prelude = spec.parameters
    .map(key => `export ${key}=${shellQuote(args[key] == null ? '' : String(args[key]))}`)
    .join('\n');
  return prelude ? `${prelude}\n${spec.command}` : spec.command;
}

/** 加载 `{cwd}/.agent/tools.json` 到 act 工具表（跑前种子；运行中不再增删）。 */
export function loadSeededTools(
  cwd: string,
  tools: Tool[],
  bodies: Map<string, RegisteredTool>,
): string[] {
  const file = path.join(cwd, '.agent', 'tools.json');
  if (!fs.existsSync(file)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const loaded: string[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const registered = registerSeededTool(entry as Record<string, unknown>, tools, bodies);
    if (registered.ok) loaded.push(registered.name);
  }
  return loaded;
}

/**
 * 把事后分析种子目录拷进 `{cwd}/.agent/`（rules / skills / tools.json）。
 * 不覆盖已有同名文件以外的工作区内容；用于新跑 place()。
 */
export function applyAgentSeed(seedDir: string, cwd: string): void {
  if (!fs.existsSync(seedDir)) return;
  const dest = path.join(cwd, '.agent');
  fs.mkdirSync(dest, { recursive: true });
  for (const name of ['rules', 'skills']) {
    const src = path.join(seedDir, name);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(dest, name), { recursive: true });
  }
  const toolsSrc = path.join(seedDir, 'tools.json');
  if (fs.existsSync(toolsSrc)) {
    fs.copyFileSync(toolsSrc, path.join(dest, 'tools.json'));
  }
}

function applyReflectTool(
  call: { id: string; name: string; arguments: Record<string, unknown> },
  memory: AgentMemory,
): ToolResultMessage {
  if (call.name === 'upsert_rule') {
    const id = String(call.arguments.id ?? '');
    const body = String(call.arguments.body ?? '');
    const saved = memory.upsertRule(id, body);
    return toolResult(call.id, 'upsert_rule', saved.ok ? `rule ${id}` : saved.error, !saved.ok);
  }
  if (call.name === 'upsert_skill') {
    const name = String(call.arguments.name ?? '');
    const body = String(call.arguments.body ?? '');
    const saved = memory.upsertSkill(name, body);
    return toolResult(call.id, 'upsert_skill', saved.ok ? `skill ${name}` : saved.error, !saved.ok);
  }
  if (call.name === 'retire_rule') {
    const id = String(call.arguments.id ?? '');
    const retired = memory.retireRule(id);
    return toolResult(call.id, 'retire_rule', retired.ok ? `retired rule ${id}` : retired.error, !retired.ok);
  }
  if (call.name === 'retire_skill') {
    const name = String(call.arguments.name ?? '');
    const retired = memory.retireSkill(name);
    return toolResult(call.id, 'retire_skill', retired.ok ? `retired skill ${name}` : retired.error, !retired.ok);
  }
  return toolResult(call.id, call.name, `unknown tool: ${call.name}`, true);
}

export async function runExecAgent(opts: ExecAgentOptions): Promise<ExecAgentResult> {
  const complete = opts.complete ?? defaultComplete;
  const exec = opts.exec ?? execCommand;
  const emit = opts.onEvent ?? (() => {});
  const messages: Message[] = [{ role: 'user', content: opts.task, timestamp: Date.now() }];
  const tools: Tool[] = [EXEC_TOOL];
  const bodies = new Map<string, RegisteredTool>();
  const toolUses = new Map<string, number>();
  const memory = new AgentMemory(opts.cwd);
  loadSeededTools(opts.cwd, tools, bodies);
  for (const name of bodies.keys()) toolUses.set(name, 0);
  emit({ type: 'memory', registeredTools: [...bodies.keys()], rules: [...memory.rules.keys()].sort(), skills: [...memory.skills.keys()].sort() });
  let steps = 0;
  let rounds = 0;
  let streak = 0;

  const basePrompt = opts.systemPrompt ?? SYSTEM_PROMPT;
  const actPrompt = () => memory.renderForAct(basePrompt);
  const memoryEvent = (): ExecAgentEvent => ({
    type: 'memory',
    registeredTools: [...bodies.keys()],
    rules: [...memory.rules.keys()].sort(),
    skills: [...memory.skills.keys()].sort(),
  });

  const done = (
    stopReason: ExecAgentResult['stopReason'],
  ): ExecAgentResult => ({
    messages,
    stopReason,
    rounds,
    registeredTools: [...bodies.keys()],
    rules: [...memory.rules.keys()].sort(),
    skills: [...memory.skills.keys()].sort(),
  });

  const reflect = async (): Promise<'ok' | 'aborted' | 'max-steps'> => {
    const local: Message[] = [...messages];
    let llmTurns = 0;
    let toolCalls = 0;
    while (true) {
      if (opts.maxSteps !== undefined && steps >= opts.maxSteps) return 'max-steps';
      if (llmTurns >= MAX_REFLECT_LLM_TURNS || toolCalls >= MAX_REFLECT_TOOL_CALLS) {
        return 'ok';
      }
      steps += 1;
      llmTurns += 1;
      emit({ type: 'llm-start', phase: 'reflect' });
      const assistant = await complete(opts.model, {
        systemPrompt: REFLECT_PROMPT,
        messages: local,
        tools: REFLECT_TOOLS,
      });
      emit({ type: 'llm-end', phase: 'reflect', stopReason: assistant.stopReason });
      if (assistant.stopReason === 'aborted') return 'aborted';
      local.push(assistant);
      if (assistant.stopReason === 'error') {
        local.push({
          role: 'user',
          content: assistant.errorMessage?.trim() || 'The model request failed. Continue.',
          timestamp: Date.now(),
        });
        continue;
      }
      const calls = assistant.content.filter(part => part.type === 'toolCall');
      if (calls.length === 0) return 'ok';
      for (const call of calls) {
        if (toolCalls >= MAX_REFLECT_TOOL_CALLS) return 'ok';
        toolCalls += 1;
        const result = applyReflectTool(call, memory);
        emit({ type: 'reflect-tool', name: call.name, ok: !result.isError });
        emit(memoryEvent());
        local.push(result);
      }
    }
  };

  const afterAct = async (ok: boolean): Promise<'ok' | 'aborted' | 'max-steps'> => {
    if (!ok) {
      streak = 0;
      return reflect();
    }
    streak += 1;
    if (streak >= ACT_SUCCESS_BEFORE_REFLECT) {
      streak = 0;
      return reflect();
    }
    return 'ok';
  };

  while (true) {
    if (opts.maxSteps !== undefined && steps >= opts.maxSteps) {
      return done('max-steps');
    }
    steps += 1;
    emit({ type: 'llm-start', phase: 'act' });
    const assistant = await complete(opts.model, {
      systemPrompt: actPrompt(),
      messages,
      tools,
    });
    emit({ type: 'llm-end', phase: 'act', stopReason: assistant.stopReason });
    messages.push(assistant);
    if (assistant.stopReason === 'aborted') return done('aborted');
    if (assistant.stopReason === 'error') {
      messages.push({
        role: 'user',
        content: assistant.errorMessage?.trim() || 'The model request failed. Continue.',
        timestamp: Date.now(),
      });
      continue;
    }

    const calls = assistant.content.filter(part => part.type === 'toolCall');
    if (calls.length === 0) {
      if (!opts.judge) return done('no-tool-call');
      rounds += 1;
      const artifact = collectArtifact(opts.cwd, lastAssistantText(assistant));
      emit({ type: 'llm-start', phase: 'judge' });
      const verdict = await opts.judge({ task: opts.task, artifact });
      emit({ type: 'llm-end', phase: 'judge', stopReason: verdict.done ? 'complete' : 'incomplete' });
      if (verdict.done) return done('complete');
      if (opts.maxRounds !== undefined && rounds >= opts.maxRounds) {
        return done('incomplete');
      }
      messages.push({
        role: 'user',
        content: 'The task is not complete. Continue from the current files.',
        timestamp: Date.now(),
      });
      continue;
    }

    for (const call of calls) {
      let ok = false;
      if (call.name === 'exec') {
        const command = String(call.arguments.command ?? '');
        if (!command.trim()) {
          messages.push(toolResult(call.id, 'exec', 'empty command', true));
        } else {
          const ran = exec(command, opts.cwd);
          ok = ran.ok;
          messages.push(toolResult(call.id, 'exec', ran.output, !ran.ok));
        }
      } else if (bodies.has(call.name)) {
        const uses = (toolUses.get(call.name) ?? 0) + 1;
        toolUses.set(call.name, uses);
        emit({ type: 'act-tool', name: call.name, uses });
        const ran = exec(commandFor(bodies.get(call.name)!, call.arguments), opts.cwd);
        ok = ran.ok;
        messages.push(toolResult(call.id, call.name, ran.output, !ran.ok));
      } else {
        messages.push(toolResult(call.id, call.name, `unknown tool: ${call.name}`, true));
      }
      const paused = await afterAct(ok);
      if (paused === 'aborted') return done('aborted');
      if (paused === 'max-steps') return done('max-steps');
    }
  }
}

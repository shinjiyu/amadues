/**
 * Workspace 脚本工具（T0 工具晋升）—— 把 workDir 内的稳定脚本声明为可调用 Tool。
 *
 * ADL：doc/structurizr/DYFLOW-INNER-EXECUTOR.md §7b
 *
 * 动机（bot2 ib-mpwfiv02-2887）：成功的「跑 ps_playwright_v6.py」「查 ELO」等动作
 * 步骤已固定，却每轮被当成 preset/base 重新 ReAct（50 轮 cap 烧 token）。T0 让
 * baseNode 把这类动作固化成 `ws_<name>` 工具，下次一次 tool_call 直接执行。
 *
 * 与 node_creator 的分界：node_creator 固化「图上的格子（仍 ReAct）」；本模块固化
 * 「allowlist 里的原子能力（一次调用）」。
 */

import fs from 'node:fs';
import path from 'node:path';

import { runCommand } from '../process/exec-runner.js';
import type { Tool, ToolParam } from '../tools/index.js';

export type ScriptInterpreter = 'python' | 'node' | 'pwsh' | 'bash' | 'cmd';

const INTERPRETERS: ReadonlySet<ScriptInterpreter> = new Set([
  'python',
  'node',
  'pwsh',
  'bash',
  'cmd',
]);

export interface WorkspaceScriptToolDef {
  /** 暴露的工具名，强制 `ws_` 前缀（slug 化） */
  name: string;
  description: string;
  interpreter: ScriptInterpreter;
  /** workDir 相对路径 */
  script: string;
  /** 仅作 LLM 提示；执行时统一通过 `args` 字符串追加到命令行 */
  argsSchema?: Record<string, ToolParam>;
  example?: string;
  createdAt: string;
}

interface WorkspaceToolsManifest {
  tools: WorkspaceScriptToolDef[];
  updatedAt: string;
}

const MANIFEST_REL = path.join('.brain', 'workspace-tools.json');
const DEFAULT_TIMEOUT_MS = 300_000;

function manifestPath(workDir: string): string {
  return path.join(workDir, MANIFEST_REL);
}

export function loadWorkspaceScriptTools(workDir: string): WorkspaceScriptToolDef[] {
  try {
    const raw = fs.readFileSync(manifestPath(workDir), 'utf8');
    const parsed = JSON.parse(raw) as WorkspaceToolsManifest;
    return Array.isArray(parsed.tools) ? parsed.tools : [];
  } catch {
    return [];
  }
}

function saveWorkspaceScriptTools(workDir: string, tools: WorkspaceScriptToolDef[]): void {
  const p = manifestPath(workDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const manifest: WorkspaceToolsManifest = { tools, updatedAt: new Date().toISOString() };
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2), 'utf8');
}

/** 规范化为 `ws_<slug>`，保证不与核心工具冲突 */
export function normalizeWorkspaceToolName(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/^ws[_-]?/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `ws_${slug || 'tool'}`;
}

/** 脚本必须落在 workDir 内（防穿越） */
export function isScriptInsideWorkDir(workDir: string, script: string): boolean {
  const root = path.resolve(workDir);
  const abs = path.resolve(root, script);
  return abs === root || abs.startsWith(root + path.sep);
}

export interface RegisterResult {
  ok: boolean;
  def?: WorkspaceScriptToolDef;
  error?: string;
}

export function registerWorkspaceScriptTool(
  workDir: string,
  input: {
    name?: unknown;
    description?: unknown;
    interpreter?: unknown;
    script?: unknown;
    args_schema?: unknown;
    example?: unknown;
  },
): RegisterResult {
  const rawName = typeof input.name === 'string' ? input.name.trim() : '';
  if (!rawName) return { ok: false, error: 'name 不能为空' };

  const script = typeof input.script === 'string' ? input.script.trim() : '';
  if (!script) return { ok: false, error: 'script（workDir 相对路径）不能为空' };

  const interpreter = String(input.interpreter ?? 'python').toLowerCase() as ScriptInterpreter;
  if (!INTERPRETERS.has(interpreter)) {
    return { ok: false, error: `interpreter 必须是 ${[...INTERPRETERS].join(' | ')}` };
  }

  if (!isScriptInsideWorkDir(workDir, script)) {
    return { ok: false, error: `script "${script}" 必须位于 workDir 内` };
  }
  if (!fs.existsSync(path.resolve(workDir, script))) {
    return { ok: false, error: `script "${script}" 不存在（请先 write_file 落盘再注册）` };
  }

  const def: WorkspaceScriptToolDef = {
    name: normalizeWorkspaceToolName(rawName),
    description: typeof input.description === 'string' && input.description.trim()
      ? input.description.trim()
      : `运行 ${script}`,
    interpreter,
    script,
    ...(input.args_schema && typeof input.args_schema === 'object'
      ? { argsSchema: input.args_schema as Record<string, ToolParam> }
      : {}),
    ...(typeof input.example === 'string' && input.example.trim()
      ? { example: input.example.trim() }
      : {}),
    createdAt: new Date().toISOString(),
  };

  const existing = loadWorkspaceScriptTools(workDir);
  const next = [...existing.filter((t) => t.name !== def.name), def];
  saveWorkspaceScriptTools(workDir, next);
  return { ok: true, def };
}

function interpreterPrefix(interpreter: ScriptInterpreter, scriptQuoted: string): string {
  switch (interpreter) {
    case 'python':
      return `python ${scriptQuoted}`;
    case 'node':
      return `node ${scriptQuoted}`;
    case 'pwsh':
      return `powershell -NoProfile -ExecutionPolicy Bypass -File ${scriptQuoted}`;
    case 'bash':
      return `bash ${scriptQuoted}`;
    case 'cmd':
      return scriptQuoted;
    default:
      return `python ${scriptQuoted}`;
  }
}

/** 把单个 def materialize 成可调用 Tool */
export function materializeWorkspaceScriptTool(workDir: string, def: WorkspaceScriptToolDef): Tool {
  const params: Record<string, ToolParam> = {
    args: {
      type: 'string',
      description: '追加到脚本命令行的参数（可空）。脚本路径与解释器由注册时固定。',
    },
    ...(def.argsSchema ?? {}),
  };
  const descParts = [def.description, `（脚本：${def.script}，解释器：${def.interpreter}）`];
  if (def.example) descParts.push(`示例：${def.example}`);

  return {
    name: def.name,
    description: descParts.join(' '),
    parameters: params,
    async call(args) {
      if (!isScriptInsideWorkDir(workDir, def.script)) {
        return { ok: false, output: `${def.name}: 脚本路径越界，拒绝执行` };
      }
      const abs = path.resolve(workDir, def.script);
      if (!fs.existsSync(abs)) {
        return { ok: false, output: `${def.name}: 脚本 ${def.script} 已不存在` };
      }
      const extra = typeof args['args'] === 'string' ? (args['args'] as string).trim() : '';
      const quoted = JSON.stringify(def.script);
      const command = `${interpreterPrefix(def.interpreter, quoted)}${extra ? ` ${extra}` : ''}`;
      const res = await runCommand(command, {
        cwd: workDir,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      return { ok: res.ok, output: res.output };
    },
  };
}

export function materializeWorkspaceScriptTools(workDir: string): Tool[] {
  return loadWorkspaceScriptTools(workDir).map((d) => materializeWorkspaceScriptTool(workDir, d));
}

/** baseNode 用于把稳定脚本晋升为工具（T0） */
export function createRegisterWorkspaceScriptToolTool(workDir: string): Tool {
  return {
    name: 'register_workspace_script_tool',
    description:
      '把一个已经跑通、步骤固定的 workDir 内脚本晋升成可复用工具（一次调用即可执行，无需再 ReAct）。' +
      '仅当动作步骤稳定、可用 (输入)->(输出) 描述、无需 LLM 临场分支时使用；否则用 node_creator 或 extract_facts。' +
      '注册后工具名形如 ws_<name>，后续可直接调用。',
    parameters: {
      name: { type: 'string', description: '工具语义名（会规范化为 ws_<name>）' },
      description: { type: 'string', description: '工具做什么（给后续 Designer/baseNode 看）' },
      interpreter: {
        type: 'string',
        description: '解释器：python | node | pwsh | bash | cmd',
        enum: ['python', 'node', 'pwsh', 'bash', 'cmd'],
      },
      script: { type: 'string', description: 'workDir 相对路径，必须已落盘' },
      args_schema: { type: 'string', description: '（可选）参数说明，仅作提示' },
      example: { type: 'string', description: '（可选）调用示例' },
    },
    required: ['name', 'interpreter', 'script'],
    async call(args) {
      const res = registerWorkspaceScriptTool(workDir, args);
      if (!res.ok) return { ok: false, output: `注册失败：${res.error}` };
      return { ok: true, output: `已注册工具 ${res.def!.name} → ${res.def!.interpreter} ${res.def!.script}` };
    },
  };
}

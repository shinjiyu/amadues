/**
 * shell_probe — 顺序执行多条探测命令，合并为一次 tool 结果（省 ReAct 轮次）。
 *
 * ADL：doc/structurizr/DYFLOW-INNER-EXECUTOR.md §6.6
 */

import { runCommand } from '../../process/exec-runner.js';
import { getWorkDir, isPathAllowed, pathSecurityError } from './workdir-guard.js';
import type { Tool } from '../index.js';

const MAX_COMMANDS = 8;
const DEFAULT_CMD_TIMEOUT_MS = 15_000;
const OUTPUT_PREVIEW = 1200;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseCommands(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((c) => String(c).trim()).filter(Boolean).slice(0, MAX_COMMANDS);
  }
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return [];
    try {
      const parsed = JSON.parse(t) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((c) => String(c).trim()).filter(Boolean).slice(0, MAX_COMMANDS);
      }
    } catch {
      /* fall through */
    }
    return t
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, MAX_COMMANDS);
  }
  return [];
}

function previewOutput(text: string): string {
  if (text.length <= OUTPUT_PREVIEW) return text;
  return `${text.slice(0, OUTPUT_PREVIEW)}\n…[probe output truncated ${text.length - OUTPUT_PREVIEW} chars]…`;
}

function parseStopOnFirstOk(raw: unknown): boolean {
  if (raw === false || raw === 'false' || raw === 0) return false;
  return true;
}

export const shellProbeTool: Tool = {
  name: 'shell_probe',
  description:
    'Run multiple shell probe commands sequentially in one call (credential/env discovery). ' +
    'Each command runs in workDir with a per-command timeout. ' +
    'By default stops when a command exits 0 with non-empty stdout/stderr. ' +
    'Pass commands as JSON array string or newline-separated list (max 8).',
  parameters: {
    commands: {
      type: 'string',
      description: 'JSON array of commands, e.g. ["cmd /c set","node -e ..."]',
    },
    stop_on_first_ok: {
      type: 'boolean',
      description: 'Stop after first exit 0 with output (default true)',
    },
    timeout_ms: {
      type: 'number',
      description: 'Per-command timeout ms (default 15000, max 60000)',
    },
  },
  required: ['commands'],

  async call(args): Promise<{ ok: boolean; output: string }> {
    const commands = parseCommands(args['commands']);
    if (commands.length === 0) {
      return { ok: false, output: 'shell_probe: commands 必填（JSON 数组或换行分隔）' };
    }

    const cwd = getWorkDir();
    if (!isPathAllowed(cwd)) {
      return { ok: false, output: pathSecurityError(cwd) };
    }

    const stopOnFirstOk = parseStopOnFirstOk(args['stop_on_first_ok']);
    const timeoutMs = Math.min(
      Number(args['timeout_ms']) || readPositiveIntEnv('INNER_SHELL_PROBE_TIMEOUT_MS', DEFAULT_CMD_TIMEOUT_MS),
      60_000,
    );

    const blocks: string[] = [];
    let anyOk = false;

    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i]!;
      const result = await runCommand(cmd, { cwd, timeoutMs, noOutputTimeoutMs: timeoutMs });
      const hit = result.ok && result.output.trim().length > 0;
      if (hit) anyOk = true;
      blocks.push(
        [
          `### [${i + 1}/${commands.length}] exit=${result.exitCode ?? '?'} ok=${result.ok} (${result.termination})`,
          `\`\`\`\n${previewOutput(result.output)}\n\`\`\``,
        ].join('\n'),
      );
      if (stopOnFirstOk && hit) {
        if (i + 1 < commands.length) {
          blocks.push(`(stopped early: stop_on_first_ok, ${commands.length - i - 1} commands skipped)`);
        }
        break;
      }
    }

    return {
      ok: anyOk,
      output: blocks.join('\n\n'),
    };
  },
};

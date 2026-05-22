import { getWorkDir } from './workdir-guard.js';
import type { Tool } from '../index.js';
import {
  verifySelfUpdate,
  rollbackSelfUpdate,
  readSelfUpdateSession,
} from '../../../self-update/session.js';

function parseCommands(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export const verifySelfUpdateTool: Tool = {
  name: 'verify_self_update',
  description:
    'Run the configured self-update verification commands inside the target repository root.\n' +
    'Optional commands overrides the default verification list for this run only.\n' +
    'Use this after editing repo files and before declaring success.',
  parameters: {
    commands: {
      type: 'string',
      description: '可选：换行分隔的验证命令列表；留空时使用会话默认 verify_commands',
    },
  },
  required: [],
  async call(args) {
    const workDir = getWorkDir();
    const raw = String(args['commands'] ?? '');
    try {
      const result = await verifySelfUpdate(workDir, raw.trim() ? parseCommands(raw) : undefined);
      const header = result.ok ? 'Self-update verification passed.' : 'Self-update verification failed.';
      const lines = result.results.map(
        (item, index) =>
          `${index + 1}. [${item.ok ? 'ok' : 'fail'}] ${item.command} ` +
          `(exit=${String(item.exitCode)} termination=${item.termination} elapsed=${item.elapsedMs}ms)`,
      );
      return {
        ok: result.ok,
        output: `${header}\n${lines.join('\n')}`,
      };
    } catch (e) {
      return { ok: false, output: String(e) };
    }
  },
};

export const rollbackSelfUpdateTool: Tool = {
  name: 'rollback_self_update',
  description:
    'Rollback the tracked repo file mutations recorded in the current self-update session.\n' +
    'Restores original files from backups and removes newly created tracked files.',
  parameters: {},
  required: [],
  async call(): Promise<{ ok: boolean; output: string }> {
    const workDir = getWorkDir();
    try {
      const result = rollbackSelfUpdate(workDir);
      const summary = [
        `restored=${result.restored.length}`,
        `removed=${result.removed.length}`,
        `skipped=${result.skipped.length}`,
      ].join(' ');
      return {
        ok: result.ok,
        output: `Self-update rollback ${result.ok ? 'completed' : 'completed with warnings'}: ${summary}`,
      };
    } catch (e) {
      return { ok: false, output: String(e) };
    }
  },
};

export const readSelfUpdatePlanTool: Tool = {
  name: 'read_self_update_plan',
  description:
    'Read the active self-update session plan, including repo scope, verify commands, and mutation status.',
  parameters: {},
  required: [],
  async call(): Promise<{ ok: boolean; output: string }> {
    const session = readSelfUpdateSession(getWorkDir());
    if (!session) return { ok: false, output: 'self-update session not initialized' };
    return {
      ok: true,
      output: JSON.stringify({
        status: session.status,
        repoRoot: session.repoRoot,
        repoScope: session.allowedPaths.length === 0 ? 'repo_root' : 'partial',
        allowedPaths: session.allowedPaths,
        verifyCommands: session.verifyCommands,
        mutations: session.mutations,
        verifications: session.verifications,
        lastError: session.lastError,
      }, null, 2),
    };
  },
};

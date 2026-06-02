/**
 * 检测 shell_exec 重复命令无进展（P2 stall guard）。
 *
 * ADL：doc/structurizr/DYFLOW-INNER-EXECUTOR.md §6.5
 */

export interface ShellStallGuard {
  record(command: string, ok: boolean): { stalled: boolean; reason: string };
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isEnabled(): boolean {
  const raw = process.env['INNER_SHELL_STALL_GUARD']?.trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  return true;
}

/** 归一化命令串便于比较（去首尾空白、压空白） */
export function normalizeShellCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

export function createShellStallGuard(): ShellStallGuard {
  const maxRepeats = readPositiveIntEnv('INNER_SHELL_STALL_MAX_REPEAT', 4);
  const counts = new Map<string, number>();

  return {
    record(command: string, ok: boolean) {
      if (!isEnabled()) return { stalled: false, reason: '' };
      const key = normalizeShellCommand(command);
      if (!key) return { stalled: false, reason: '' };
      if (ok) {
        counts.delete(key);
        return { stalled: false, reason: '' };
      }
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      if (next >= maxRepeats) {
        return {
          stalled: true,
          reason: `同一 shell 命令已连续失败 ${next} 次（stall guard）`,
        };
      }
      return { stalled: false, reason: '' };
    },
  };
}

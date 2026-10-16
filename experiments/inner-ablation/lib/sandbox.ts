import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SANDBOX_NODE_NAME = 'abl-node';
export const BLOCKED_KILL_LOG = path.join('.run', 'blocked-kill.log');

/**
 * 运行器与子进程改用改名的 node（`killall node` 打不到），并在 PATH 前插 killall/pkill 垫片：
 * 按进程名整杀 node 的命令被拒绝并记到工作目录 `.run/blocked-kill.log`。
 */
export function prepareSandboxBin(outDir: string): { binDir: string; nodeBin: string } {
  const binDir = path.join(outDir, '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  const nodeBin = path.join(binDir, SANDBOX_NODE_NAME);
  if (!fs.existsSync(nodeBin)) {
    try {
      fs.linkSync(process.execPath, nodeBin);
    } catch {
      fs.copyFileSync(process.execPath, nodeBin);
      fs.chmodSync(nodeBin, 0o755);
    }
  }
  const guard = (realBin: string) => `#!/bin/sh
for a in "$@"; do
  case "$a" in
    node|nodejs|tsx)
      echo "[ablation-sandbox] refused: $(basename "$0") $* (kills every node process on the host; target a pid or a specific script instead)" >&2
      [ -n "$INNER_WORK_DIR" ] && mkdir -p "$INNER_WORK_DIR/.run" && echo "$(date -u +%FT%TZ) $(basename "$0") $*" >> "$INNER_WORK_DIR/${BLOCKED_KILL_LOG}"
      exit 1 ;;
  esac
done
exec ${realBin} "$@"
`;
  fs.writeFileSync(path.join(binDir, 'killall'), guard('/usr/bin/killall'), { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, 'pkill'), guard('/usr/bin/pkill'), { mode: 0o755 });
  return { binDir, nodeBin };
}

function sh(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/**
 * 回收 agent 在宿主上留下、指向本次工作目录的东西：launchd 作业与 plist、crontab 行、命令行含工作目录的进程。
 * 返回清理记录（写进运行结果）。
 */
export function cleanupHostResidue(workDir: string): string[] {
  const out: string[] = [];
  const uid = process.getuid?.() ?? 501;

  const labels = sh('launchctl', ['list'])
    .split('\n')
    .slice(1)
    .map(l => l.trim().split(/\s+/)[2])
    .filter((l): l is string => !!l && !l.startsWith('com.apple.'));
  for (const label of labels) {
    if (sh('launchctl', ['print', `gui/${uid}/${label}`]).includes(workDir)) {
      sh('launchctl', ['bootout', `gui/${uid}/${label}`]);
      out.push(`launchd:${label}`);
    }
  }

  const agentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  if (fs.existsSync(agentsDir)) {
    for (const f of fs.readdirSync(agentsDir)) {
      const p = path.join(agentsDir, f);
      try {
        if (fs.readFileSync(p, 'utf8').includes(workDir)) {
          fs.rmSync(p, { force: true });
          out.push(`plist:${f}`);
        }
      } catch { /* unreadable */ }
    }
  }

  const cron = sh('crontab', ['-l']);
  if (cron.includes(workDir)) {
    const kept = cron.split('\n').filter(l => !l.includes(workDir)).join('\n');
    try {
      execFileSync('crontab', ['-'], { input: kept.endsWith('\n') ? kept : kept + '\n' });
      out.push('crontab');
    } catch { /* leave it, but report */ }
  }

  const pids = sh('pgrep', ['-f', workDir])
    .split('\n')
    .map(s => Number(s.trim()))
    .filter(n => Number.isInteger(n) && n > 0 && n !== process.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
      out.push(`pid:${pid}`);
    } catch { /* gone */ }
  }
  return out;
}

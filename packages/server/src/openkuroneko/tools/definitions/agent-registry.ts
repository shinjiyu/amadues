/**
 * list_agents / stop_agent — Agent 进程注册表工具
 *
 * list_agents：扫描全局临时目录下所有 .lock 文件，
 *              返回存活 agent 的 id、pid、路径、soul 摘要。
 *
 * stop_agent：向目标 agent 发送 SIGTERM，等待进程退出。
 *             需要指定 agent_path 或 agent_id。
 */

import fs from 'node:fs';
import path from 'node:path';
import { globalTmpDir, deriveAgentId } from '../../identity/index.js';
import type { Tool } from '../index.js';

interface AgentInfo {
  agentId: string;
  pid: number;
  alive: boolean;
  agentPath?: string | undefined;
  soulPreview?: string | undefined;
}

function readAllAgents(): AgentInfo[] {
  const tmpDir = globalTmpDir();
  const agents: AgentInfo[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(tmpDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.lock')) continue;

    const agentId = entry.name.slice(0, -5); // strip .lock
    const raw = fs.readFileSync(path.join(tmpDir, entry.name), 'utf8').trim();
    const pid = Number(raw);
    if (isNaN(pid)) continue;

    const alive = isPidAlive(pid);

    // Try to read soul preview from agent temp dir
    let soulPreview: string | undefined;
    const soulPath = path.join(tmpDir, agentId, 'soul.md');
    if (fs.existsSync(soulPath)) {
      const soul = fs.readFileSync(soulPath, 'utf8');
      soulPreview = soul.slice(0, 100).replace(/\n/g, ' ');
    }

    // Try to read agentPath from config
    let agentPath: string | undefined;
    const cfgPath = path.join(tmpDir, agentId, 'agent.config.json');
    if (fs.existsSync(cfgPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { agentPath?: string };
        agentPath = cfg.agentPath;
      } catch { /* ignore */ }
    }

    agents.push({ agentId, pid, alive, agentPath, soulPreview });
  }

  return agents;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ── list_agents ───────────────────────────────────────────────────────────────

export const listAgentsTool: Tool = {
  name: 'list_agents',
  description:
    'List all running agent processes. ' +
    'filter (optional): "alive" (default) | "all" to include dead locks.',

  async call(args): Promise<{ ok: boolean; output: string }> {
    const filter = String(args['filter'] ?? 'alive');
    const agents = readAllAgents().filter((a) => filter === 'all' || a.alive);

    if (agents.length === 0) {
      return { ok: true, output: 'No agents found.' };
    }

    const lines = agents.map((a) =>
      [
        `agent_id : ${a.agentId}`,
        `pid      : ${a.pid} (${a.alive ? 'alive' : 'dead'})`,
        a.agentPath ? `path     : ${a.agentPath}` : '',
        a.soulPreview ? `soul     : ${a.soulPreview}…` : '',
      ]
        .filter(Boolean)
        .join('\n')
    );

    return { ok: true, output: lines.join('\n\n') };
  },
};

// ── stop_agent ────────────────────────────────────────────────────────────────

export const stopAgentTool: Tool = {
  name: 'stop_agent',
  description:
    'Send SIGTERM to a running agent. ' +
    'agent_path (optional): agent directory path. ' +
    'agent_id (optional): agent_id from list_agents. ' +
    'One of the two is required.',

  async call(args): Promise<{ ok: boolean; output: string }> {
    let agentId = String(args['agent_id'] ?? '').trim();
    const agentPath = String(args['agent_path'] ?? '').trim();

    if (!agentId && agentPath) {
      agentId = deriveAgentId(agentPath);
    }
    if (!agentId) {
      return { ok: false, output: 'Provide agent_id or agent_path.' };
    }

    const lockFile = path.join(globalTmpDir(), agentId + '.lock');
    if (!fs.existsSync(lockFile)) {
      return { ok: false, output: `No lock file found for agent_id "${agentId}".` };
    }

    const raw = fs.readFileSync(lockFile, 'utf8').trim();
    const pid = Number(raw);
    if (isNaN(pid)) {
      return { ok: false, output: `Invalid PID in lock file: "${raw}".` };
    }

    if (!isPidAlive(pid)) {
      fs.rmSync(lockFile, { force: true });
      return { ok: true, output: `PID ${pid} is already dead. Stale lock cleaned up.` };
    }

    try {
      process.kill(pid, 'SIGTERM');
      return { ok: true, output: `SIGTERM sent to agent_id="${agentId}" (PID ${pid}).` };
    } catch (e) {
      return { ok: false, output: `Failed to send SIGTERM: ${String(e)}` };
    }
  },
};

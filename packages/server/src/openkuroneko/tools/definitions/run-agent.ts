/**
 * run_agent — 启动子 Agent
 *
 * 协议文档：doc/protocols/run-agent-contract.md
 *
 * Args:
 *   path     {string}   子 Agent 目录（决定 identity），必填
 *   input    {string?}  启动前注入子 Agent 默认 input 端点的内容
 *   once     {boolean?} true → spawnSync 等待完成并读回 output（默认 true）
 *                       false → spawn 后台，不等待
 *   args     {string[]?} 追加 CLI 参数
 *   timeout  {number?}  once 模式等待超时 ms（默认 60000）
 */

import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { deriveAgentId, globalTmpDir } from '../../identity/index.js';
import type { Tool } from '../index.js';

function childTempDir(childPath: string): string {
  const childId = deriveAgentId(childPath);
  return path.join(globalTmpDir(), childId);
}

function injectInput(childPath: string, input: string): void {
  const dir = childTempDir(childPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'input'), input, 'utf8');
}

function readOutput(childPath: string): string {
  const outFile = path.join(childTempDir(childPath), 'output');
  if (!fs.existsSync(outFile)) return '';
  const content = fs.readFileSync(outFile, 'utf8').trim();
  // consume output after reading (parent reads it once)
  fs.truncateSync(outFile, 0);
  return content;
}

function cliBin(): string {
  // Prefer compiled dist; fall back to tsx for dev
  const distBin = path.join(process.cwd(), 'dist', 'cli', 'index.js');
  if (fs.existsSync(distBin)) return distBin;
  return path.join(process.cwd(), 'src', 'cli', 'index.ts');
}

function buildArgs(agentPath: string, once: boolean, extraArgs: string[]): string[] {
  const bin = cliBin();
  const useTs = bin.endsWith('.ts');
  const baseCmd = useTs ? ['tsx', bin] : ['node', bin];
  return [
    ...baseCmd,
    '--dir', path.resolve(agentPath),
    ...(once ? ['--once'] : ['--loop', 'fast']),
    ...extraArgs,
  ];
}

export const runAgentTool: Tool = {
  name: 'run_agent',
  description:
    'Start a sub-agent process. ' +
    'path (required): agent directory. ' +
    'input (optional): text to inject into the sub-agent default input endpoint. ' +
    'once (optional, default true): wait for completion and return output. ' +
    'timeout (optional, default 60000ms): max wait time when once=true. ' +
    'args (optional): extra CLI args.',

  async call(args): Promise<{ ok: boolean; output: string }> {
    const agentPath = String(args['path'] ?? '').trim();
    if (!agentPath) return { ok: false, output: 'Missing required argument: path' };

    const once       = args['once'] !== false;  // default true
    const input      = args['input'] != null ? String(args['input']) : null;
    const timeout    = Number(args['timeout'] ?? 60_000);
    const extraArgs  = Array.isArray(args['args']) ? args['args'].map(String) : [];

    // Inject input before spawning
    if (input) {
      try {
        injectInput(agentPath, input);
      } catch (e) {
        return { ok: false, output: `Failed to inject input: ${String(e)}` };
      }
    }

    const [cmd, ...cmdArgs] = buildArgs(agentPath, once, extraArgs);
    if (!cmd) return { ok: false, output: 'Internal error: empty command' };

    // ── once mode: spawnSync, wait for exit ──────────────────────────────
    if (once) {
      const result = spawnSync(cmd, cmdArgs, {
        encoding: 'utf8',
        timeout,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stdout = result.stdout ?? '';
      const stderr = result.stderr ?? '';
      const exitCode = result.status ?? -1;

      // Read sub-agent output endpoint
      let agentOutput = '';
      try { agentOutput = readOutput(agentPath); } catch { /* ignore */ }

      const summary = [
        agentOutput ? `[output]\n${agentOutput}` : '',
        stdout       ? `[stdout]\n${stdout.slice(0, 500)}` : '',
        stderr       ? `[stderr]\n${stderr.slice(0, 200)}` : '',
        `[exit ${exitCode}]`,
      ].filter(Boolean).join('\n');

      return { ok: exitCode === 0, output: summary };
    }

    // ── background mode: spawn detached, don't wait ──────────────────────
    const child = spawn(cmd, cmdArgs, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();

    const childId = deriveAgentId(agentPath);
    return {
      ok: true,
      output: `Sub-agent started in background. agent_id=${childId} pid=${child.pid ?? '?'}`,
    };
  },
};

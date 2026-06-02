import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  recordInnerToolCall,
  recordInnerToolResult,
  resolveInnerToolAuditPaths,
} from './inner-tool-audit.js';

describe('inner-tool-audit', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-audit-'));
  });

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('resolveInnerToolAuditPaths from workspaces layout', () => {
    const workDir = path.join(root, 'data-bot2', 'workspaces', 'task-ib-abc');
    fs.mkdirSync(workDir, { recursive: true });
    const p = resolveInnerToolAuditPaths(workDir);
    expect(p.dataRoot).toBe(path.join(root, 'data-bot2'));
    expect(p.workspaceId).toBe('task-ib-abc');
  });

  it('writes tool.call and tool.result jsonl', () => {
    const ws = 'task-ib-test';
    recordInnerToolCall({
      dataRoot: root,
      workspaceId: ws,
      module: 'base-node',
      nodeInstId: 'n1_research',
      burstId: 'kpi-x',
      reactRound: 3,
      toolName: 'web_search',
      args: { action: 'search', query: 'pokemon showdown websocket' },
    });
    recordInnerToolResult({
      dataRoot: root,
      workspaceId: ws,
      module: 'base-node',
      nodeInstId: 'n1_research',
      burstId: 'kpi-x',
      reactRound: 3,
      toolName: 'web_search',
      ok: true,
      output: 'result line one',
      durationMs: 42,
    });

    const day = new Date().toISOString().slice(0, 10);
    const fp = path.join(root, 'inner', 'tool-logs', ws, `${day}.jsonl`);
    expect(fs.existsSync(fp)).toBe(true);
    const lines = fs.readFileSync(fp, 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    const call = JSON.parse(lines[0]!) as { event: string; module: string };
    const result = JSON.parse(lines[1]!) as { event: string; data: { ok: boolean } };
    expect(call.event).toBe('tool.call');
    expect(call.module).toBe('base-node');
    expect(result.event).toBe('tool.result');
    expect(result.data.ok).toBe(true);
  });
});

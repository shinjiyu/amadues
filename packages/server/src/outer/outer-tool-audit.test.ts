/**
 * @see outer-tool-audit.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isToolOutputOk, recordOuterToolCall, recordOuterToolResult, redactToolArgs } from './outer-tool-audit.js';

describe('outer-tool-audit', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'outer-audit-'));
  });

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('redactToolArgs hides keychain value', () => {
    const r = redactToolArgs('keychain_put', { key: 'x', kind: 'cookie', value: 'secret=abc' });
    expect(r.value).toBe('[REDACTED len=10]');
    expect(r.key).toBe('x');
  });

  it('writes tool.call and tool.result jsonl', () => {
    recordOuterToolCall({
      dataRoot: root,
      agentSid: 'idp:agent:gin',
      threadId: 'webchat:global',
      round: 1,
      toolName: 'keychain_put',
      argsJson: JSON.stringify({ key: 'k1', value: 'v' }),
    });
    recordOuterToolResult({
      dataRoot: root,
      agentSid: 'idp:agent:gin',
      threadId: 'webchat:global',
      round: 1,
      toolName: 'keychain_put',
      output: '已写入并校验 keychain/k1',
      ok: true,
      durationMs: 12,
    });

    const day = new Date().toISOString().slice(0, 10);
    const fp = path.join(root, 'outer', 'tool-logs', 'idp_agent_gin', `${day}.jsonl`);
    expect(fs.existsSync(fp)).toBe(true);
    const lines = fs.readFileSync(fp, 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    const call = JSON.parse(lines[0]!) as { event: string };
    const result = JSON.parse(lines[1]!) as { event: string; data: { ok: boolean } };
    expect(call.event).toBe('tool.call');
    expect(result.event).toBe('tool.result');
    expect(result.data.ok).toBe(true);
  });

  it('isToolOutputOk detects Chinese error prefix', () => {
    expect(isToolOutputOk('已写入 keychain/x')).toBe(true);
    expect(isToolOutputOk('（错误：boom）')).toBe(false);
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  normalizeWorkspaceToolName,
  isScriptInsideWorkDir,
  registerWorkspaceScriptTool,
  loadWorkspaceScriptTools,
  materializeWorkspaceScriptTools,
  createRegisterWorkspaceScriptToolTool,
} from './workspace-script-tools.js';

describe('workspace-script-tools', () => {
  let root: string;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  function freshWorkDir(): string {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-tools-'));
    return root;
  }

  describe('normalizeWorkspaceToolName', () => {
    it('forces ws_ prefix and slugifies', () => {
      expect(normalizeWorkspaceToolName('Run PS v6')).toBe('ws_run_ps_v6');
      expect(normalizeWorkspaceToolName('ws_query-elo')).toBe('ws_query_elo');
      expect(normalizeWorkspaceToolName('ws-foo')).toBe('ws_foo');
    });
    it('falls back when empty', () => {
      expect(normalizeWorkspaceToolName('ws_')).toBe('ws_tool');
    });
  });

  describe('isScriptInsideWorkDir', () => {
    it('rejects traversal', () => {
      const w = freshWorkDir();
      expect(isScriptInsideWorkDir(w, 'bot.py')).toBe(true);
      expect(isScriptInsideWorkDir(w, '../escape.py')).toBe(false);
      expect(isScriptInsideWorkDir(w, 'sub/ok.py')).toBe(true);
    });
  });

  describe('registerWorkspaceScriptTool', () => {
    it('rejects when script missing', () => {
      const w = freshWorkDir();
      const r = registerWorkspaceScriptTool(w, { name: 'x', interpreter: 'python', script: 'nope.py' });
      expect(r.ok).toBe(false);
      expect(r.error).toContain('不存在');
    });

    it('rejects traversal script', () => {
      const w = freshWorkDir();
      const r = registerWorkspaceScriptTool(w, { name: 'x', interpreter: 'python', script: '../x.py' });
      expect(r.ok).toBe(false);
      expect(r.error).toContain('workDir');
    });

    it('rejects bad interpreter', () => {
      const w = freshWorkDir();
      fs.writeFileSync(path.join(w, 'a.py'), 'print(1)');
      const r = registerWorkspaceScriptTool(w, { name: 'x', interpreter: 'ruby', script: 'a.py' });
      expect(r.ok).toBe(false);
      expect(r.error).toContain('interpreter');
    });

    it('registers and dedupes by normalized name', () => {
      const w = freshWorkDir();
      fs.writeFileSync(path.join(w, 'bot.py'), 'print(1)');
      const r1 = registerWorkspaceScriptTool(w, {
        name: 'Run Bot',
        description: 'run the bot',
        interpreter: 'python',
        script: 'bot.py',
      });
      expect(r1.ok).toBe(true);
      expect(r1.def?.name).toBe('ws_run_bot');

      // re-register same normalized name → replace, not duplicate
      const r2 = registerWorkspaceScriptTool(w, {
        name: 'ws_run_bot',
        description: 'updated',
        interpreter: 'python',
        script: 'bot.py',
      });
      expect(r2.ok).toBe(true);

      const all = loadWorkspaceScriptTools(w);
      expect(all).toHaveLength(1);
      expect(all[0]?.description).toBe('updated');
    });
  });

  describe('materialize + register tool', () => {
    it('register tool persists and materializes a callable', async () => {
      const w = freshWorkDir();
      fs.writeFileSync(path.join(w, 'echo.py'), 'print("hi")');
      const regTool = createRegisterWorkspaceScriptToolTool(w);
      const out = await regTool.call({ name: 'echo', interpreter: 'python', script: 'echo.py' });
      expect(out.ok).toBe(true);
      expect(out.output).toContain('ws_echo');

      const tools = materializeWorkspaceScriptTools(w);
      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe('ws_echo');
      // materialized tool exposes an `args` param
      expect(tools[0]?.parameters).toHaveProperty('args');
    });

    it('materialized tool fails gracefully when script removed', async () => {
      const w = freshWorkDir();
      fs.writeFileSync(path.join(w, 'gone.py'), 'print(1)');
      registerWorkspaceScriptTool(w, { name: 'gone', interpreter: 'python', script: 'gone.py' });
      fs.rmSync(path.join(w, 'gone.py'));
      const tool = materializeWorkspaceScriptTools(w)[0]!;
      const res = await tool.call({});
      expect(res.ok).toBe(false);
      expect(res.output).toContain('不存在');
    });
  });
});

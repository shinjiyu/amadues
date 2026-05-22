/**
 * GitStore 单测——验证 workspace 自动 git init + 提交。
 *
 * 用临时目录 + isomorphic-git 直接读 log，不依赖系统 git / hutao。
 */

import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';

import { createGitStore } from './git-store.js';

function tmpWorkDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gitstore-test-'));
}

async function readLog(dir: string): Promise<string[]> {
  const log = await git.log({ fs, dir });
  return log.map((c) => c.commit.message.split('\n')[0] ?? '');
}

describe('GitStore', () => {
  let dir: string;
  beforeEach(() => { dir = tmpWorkDir(); });

  it('init creates .git and a first commit', async () => {
    const store = createGitStore(dir);
    await store.init();
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(true);
    const messages = await readLog(dir);
    expect(messages.some((m) => m.includes('init'))).toBe(true);
  });

  it('commit captures workspace file changes', async () => {
    const store = createGitStore(dir);
    await store.init();
    fs.mkdirSync(path.join(dir, '.brain'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.brain', 'goal.md'), 'first goal', 'utf8');
    const oid1 = await store.commit('first commit', { mode: 'DECOMPOSE' });
    expect(oid1).toBeTruthy();

    fs.writeFileSync(path.join(dir, '.brain', 'goal.md'), 'updated goal', 'utf8');
    const oid2 = await store.commit('updated', { mode: 'EXECUTE' });
    expect(oid2).toBeTruthy();
    expect(oid2).not.toBe(oid1);

    const messages = await readLog(dir);
    expect(messages.some((m) => m.includes('first commit'))).toBe(true);
    expect(messages.some((m) => m.includes('updated'))).toBe(true);
  });

  it('commit with no changes returns null', async () => {
    const store = createGitStore(dir);
    await store.init();
    fs.mkdirSync(path.join(dir, '.brain'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.brain', 'goal.md'), 'g', 'utf8');
    await store.commit('first', {});
    const oid = await store.commit('no-op', {});
    expect(oid).toBeNull();
  });

  it('honors UTLRA_AGENT_GIT=0 → noop', async () => {
    const prev = process.env['UTLRA_AGENT_GIT'];
    process.env['UTLRA_AGENT_GIT'] = '0';
    try {
      const store = createGitStore(dir);
      expect(store.enabled).toBe(false);
      const oid = await store.commit('x');
      expect(oid).toBeNull();
      expect(fs.existsSync(path.join(dir, '.git'))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env['UTLRA_AGENT_GIT'];
      else process.env['UTLRA_AGENT_GIT'] = prev;
    }
  });
});

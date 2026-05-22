import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getSelfUpdateAllowedDirs,
  initSelfUpdateSession,
  prepareSelfUpdateMutation,
  readSelfUpdateSession,
  rollbackSelfUpdate,
  verifySelfUpdate,
} from './session.js';

function makeTmp(): { root: string; workDir: string; repoRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kuroneko-self-update-'));
  const workDir = path.join(root, 'workspace');
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(repoRoot, { recursive: true });
  return { root, workDir, repoRoot };
}

describe('self update session', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('initializes session and exposes repo root as allowed dir', () => {
    const tmp = makeTmp();
    roots.push(tmp.root);

    const session = initSelfUpdateSession(tmp.workDir, {
      repoRoot: tmp.repoRoot,
      verifyCommands: ['node -e "process.exit(0)"'],
    });

    expect(session.status).toBe('initialized');
    expect(session.allowedPaths).toEqual([]);
    expect(getSelfUpdateAllowedDirs(tmp.workDir)).toEqual([tmp.repoRoot]);
  });

  it('backs up tracked repo files and restores them on rollback', () => {
    const tmp = makeTmp();
    roots.push(tmp.root);

    initSelfUpdateSession(tmp.workDir, {
      repoRoot: tmp.repoRoot,
      verifyCommands: ['node -e "process.exit(0)"'],
    });

    const target = path.join(tmp.repoRoot, 'packages', 'server', 'src', 'demo.ts');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'export const x = 1;\n', 'utf8');

    const prep = prepareSelfUpdateMutation(tmp.workDir, target);
    expect(prep.ok).toBe(true);

    fs.writeFileSync(target, 'export const x = 2;\n', 'utf8');
    const rolled = rollbackSelfUpdate(tmp.workDir);
    expect(rolled.ok).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('export const x = 1;\n');
  });

  it('tracks any repo-root file when no allowlist is declared', () => {
    const tmp = makeTmp();
    roots.push(tmp.root);

    initSelfUpdateSession(tmp.workDir, {
      repoRoot: tmp.repoRoot,
      verifyCommands: ['node -e "process.exit(0)"'],
    });

    const target = path.join(tmp.repoRoot, 'README.md');
    fs.writeFileSync(target, 'hello\n', 'utf8');

    const prep = prepareSelfUpdateMutation(tmp.workDir, target);
    expect(prep.ok).toBe(true);
    expect(readSelfUpdateSession(tmp.workDir)?.mutations[0]?.path).toBe('README.md');
  });

  it('runs verify commands and stores successful verification status', async () => {
    const tmp = makeTmp();
    roots.push(tmp.root);

    initSelfUpdateSession(tmp.workDir, {
      repoRoot: tmp.repoRoot,
      verifyCommands: ['node -e "process.exit(0)"'],
    });

    const result = await verifySelfUpdate(tmp.workDir);
    expect(result.ok).toBe(true);
    const session = readSelfUpdateSession(tmp.workDir);
    expect(session?.status).toBe('verified');
    expect(session?.verifications).toHaveLength(1);
  });
});

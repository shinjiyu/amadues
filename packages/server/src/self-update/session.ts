import fs from 'node:fs';
import path from 'node:path';
import { runCommand, type RunResult } from '../openkuroneko/process/exec-runner.js';

export type SelfUpdateStatus =
  | 'initialized'
  | 'applying'
  | 'verifying'
  | 'verified'
  | 'verify_failed'
  | 'rolled_back';

export interface SelfUpdateMutation {
  path: string;
  existedBefore: boolean;
  backupPath?: string;
  recordedAt: string;
}

export interface SelfUpdateVerification {
  ts: string;
  command: string;
  ok: boolean;
  exitCode: number | null;
  termination: string;
  elapsedMs: number;
  outputPreview: string;
}

export interface SelfUpdateSession {
  schema: 'self-update-session.v1';
  enabled: true;
  repoRoot: string;
  /** 为空表示整个 repoRoot 都可更新；保留字段仅用于兼容旧会话 */
  allowedPaths: string[];
  verifyCommands: string[];
  status: SelfUpdateStatus;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
  mutations: SelfUpdateMutation[];
  verifications: SelfUpdateVerification[];
}

export interface InitSelfUpdateSessionInput {
  repoRoot: string;
  allowedPaths?: string[];
  verifyCommands: string[];
}

export interface VerifySelfUpdateResult {
  ok: boolean;
  commands: string[];
  results: Array<{
    command: string;
    ok: boolean;
    exitCode: number | null;
    termination: string;
    elapsedMs: number;
    output: string;
  }>;
}

export interface RollbackSelfUpdateResult {
  ok: boolean;
  restored: string[];
  removed: string[];
  skipped: string[];
}

const SESSION_REL = path.join('.run', 'self-update', 'session.json');
const BACKUPS_REL = path.join('.run', 'self-update', 'backups');

function normalizeRel(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function sanitizeList(items: readonly string[]): string[] {
  return [...new Set(
    items
      .map((item) => normalizeRel(item.trim()))
      .filter((item) => !!item && item !== '.' && !item.startsWith('..') && !path.isAbsolute(item)),
  )];
}

export function selfUpdateSessionPath(workDir: string): string {
  return path.join(workDir, SESSION_REL);
}

function selfUpdateBackupsDir(workDir: string): string {
  return path.join(workDir, BACKUPS_REL);
}

export function readSelfUpdateSession(workDir: string): SelfUpdateSession | null {
  const fp = selfUpdateSessionPath(workDir);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8')) as SelfUpdateSession;
  } catch {
    return null;
  }
}

function writeSelfUpdateSession(workDir: string, session: SelfUpdateSession): SelfUpdateSession {
  const fp = selfUpdateSessionPath(workDir);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(session, null, 2), 'utf8');
  return session;
}

export function initSelfUpdateSession(workDir: string, input: InitSelfUpdateSessionInput): SelfUpdateSession {
  const repoRoot = path.resolve(input.repoRoot);
  const allowedPaths = sanitizeList(input.allowedPaths ?? []);
  const verifyCommands = input.verifyCommands.map((cmd) => cmd.trim()).filter(Boolean);
  if (verifyCommands.length === 0) {
    throw new Error('self-update requires at least one verify command');
  }
  const now = new Date().toISOString();
  const session: SelfUpdateSession = {
    schema: 'self-update-session.v1',
    enabled: true,
    repoRoot,
    allowedPaths,
    verifyCommands,
    status: 'initialized',
    createdAt: now,
    updatedAt: now,
    lastError: null,
    mutations: [],
    verifications: [],
  };
  writeSelfUpdateSession(workDir, session);
  return session;
}

export function getSelfUpdateAllowedDirs(workDir: string): string[] {
  const session = readSelfUpdateSession(workDir);
  return session?.enabled ? [session.repoRoot] : [];
}

function isUnderDir(absPath: string, root: string): boolean {
  const resolvedPath = path.resolve(absPath);
  const resolvedRoot = path.resolve(root);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(resolvedRoot + path.sep);
}

function repoRelativePath(session: SelfUpdateSession, absPath: string): string | null {
  if (!isUnderDir(absPath, session.repoRoot)) return null;
  const rel = normalizeRel(path.relative(session.repoRoot, absPath));
  return rel || null;
}

function pathAllowedForMutation(session: SelfUpdateSession, repoRelPath: string): boolean {
  if (session.allowedPaths.length === 0) return true;
  return session.allowedPaths.some((allowed) => {
    const normalizedAllowed = normalizeRel(allowed);
    return repoRelPath === normalizedAllowed || repoRelPath.startsWith(normalizedAllowed + '/');
  });
}

function backupFilePath(workDir: string, repoRelPath: string): string {
  return path.join(selfUpdateBackupsDir(workDir), ...repoRelPath.split('/'));
}

function saveSessionMutation(workDir: string, session: SelfUpdateSession): void {
  session.updatedAt = new Date().toISOString();
  writeSelfUpdateSession(workDir, session);
}

export function getSelfUpdatePromptContext(workDir: string): {
  repoRoot: string;
  repoScope: 'repo_root' | 'partial';
  verifyCommands: string[];
  status: SelfUpdateStatus;
  pendingMutationCount: number;
} | null {
  const session = readSelfUpdateSession(workDir);
  if (!session?.enabled) return null;
  return {
    repoRoot: session.repoRoot,
    repoScope: session.allowedPaths.length === 0 ? 'repo_root' : 'partial',
    verifyCommands: session.verifyCommands,
    status: session.status,
    pendingMutationCount: session.mutations.length,
  };
}

export function prepareSelfUpdateMutation(workDir: string, absPath: string): { ok: true } | { ok: false; reason: string } {
  const session = readSelfUpdateSession(workDir);
  if (!session?.enabled) return { ok: true };

  const repoRelPath = repoRelativePath(session, absPath);
  if (!repoRelPath) return { ok: true };
  if (!pathAllowedForMutation(session, repoRelPath)) {
    return {
      ok: false,
      reason:
        `self-update write denied for ${repoRelPath}. ` +
        `Allowed paths: ${session.allowedPaths.join(', ')}`,
    };
  }

  const existing = session.mutations.find((mutation) => mutation.path === repoRelPath);
  if (existing) return { ok: true };

  const now = new Date().toISOString();
  const exists = fs.existsSync(absPath);
  let backupRel: string | undefined;
  if (exists) {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) {
      return { ok: false, reason: `self-update only supports regular files, got: ${repoRelPath}` };
    }
    const backupAbs = backupFilePath(workDir, repoRelPath);
    fs.mkdirSync(path.dirname(backupAbs), { recursive: true });
    fs.copyFileSync(absPath, backupAbs);
    backupRel = normalizeRel(path.relative(workDir, backupAbs));
  }

  session.mutations.push({
    path: repoRelPath,
    existedBefore: exists,
    backupPath: backupRel,
    recordedAt: now,
  });
  if (session.status === 'initialized' || session.status === 'verified') {
    session.status = 'applying';
  }
  session.lastError = null;
  saveSessionMutation(workDir, session);
  return { ok: true };
}

export async function verifySelfUpdate(
  workDir: string,
  overrideCommands?: string[],
): Promise<VerifySelfUpdateResult> {
  const session = readSelfUpdateSession(workDir);
  if (!session?.enabled) {
    throw new Error('self-update session not initialized');
  }
  const commands = (overrideCommands ?? session.verifyCommands).map((cmd) => cmd.trim()).filter(Boolean);
  if (commands.length === 0) {
    throw new Error('no verify commands configured');
  }

  session.status = 'verifying';
  session.updatedAt = new Date().toISOString();
  session.lastError = null;
  writeSelfUpdateSession(workDir, session);

  const results: VerifySelfUpdateResult['results'] = [];
  for (const command of commands) {
    const run: RunResult = await runCommand(command, {
      cwd: session.repoRoot,
      timeoutMs: 600_000,
      noOutputTimeoutMs: 180_000,
    });
    results.push({
      command,
      ok: run.ok,
      exitCode: run.exitCode,
      termination: run.termination,
      elapsedMs: run.elapsedMs,
      output: run.output,
    });
    session.verifications.push({
      ts: new Date().toISOString(),
      command,
      ok: run.ok,
      exitCode: run.exitCode,
      termination: run.termination,
      elapsedMs: run.elapsedMs,
      outputPreview: run.output.slice(0, 2000),
    });
    if (!run.ok) {
      session.status = 'verify_failed';
      session.lastError = `verify failed: ${command}`;
      session.updatedAt = new Date().toISOString();
      writeSelfUpdateSession(workDir, session);
      return { ok: false, commands, results };
    }
  }

  session.status = 'verified';
  session.lastError = null;
  session.updatedAt = new Date().toISOString();
  writeSelfUpdateSession(workDir, session);
  return { ok: true, commands, results };
}

export function rollbackSelfUpdate(workDir: string): RollbackSelfUpdateResult {
  const session = readSelfUpdateSession(workDir);
  if (!session?.enabled) {
    throw new Error('self-update session not initialized');
  }

  const restored: string[] = [];
  const removed: string[] = [];
  const skipped: string[] = [];

  for (const mutation of [...session.mutations].reverse()) {
    const abs = path.join(session.repoRoot, ...mutation.path.split('/'));
    try {
      if (mutation.existedBefore && mutation.backupPath) {
        const backupAbs = path.join(workDir, ...mutation.backupPath.split('/'));
        if (!fs.existsSync(backupAbs)) {
          skipped.push(`${mutation.path} (missing backup)`);
          continue;
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.copyFileSync(backupAbs, abs);
        restored.push(mutation.path);
      } else if (!mutation.existedBefore) {
        if (fs.existsSync(abs)) {
          fs.rmSync(abs, { force: true });
        }
        removed.push(mutation.path);
      }
    } catch (e) {
      skipped.push(`${mutation.path} (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  session.status = 'rolled_back';
  session.lastError = skipped.length > 0 ? `rollback completed with ${skipped.length} skipped item(s)` : null;
  session.updatedAt = new Date().toISOString();
  writeSelfUpdateSession(workDir, session);

  return { ok: skipped.length === 0, restored, removed, skipped };
}

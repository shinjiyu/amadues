/**
 * Fixture 读取器 — 对齐 doc/testing-strategy.md §5「测试代码禁忌」。
 *
 * 用法：
 *   const reply = loadFixtureJson('llm-replies/decomposer-2-milestones.json');
 *
 * 默认根目录：`<server pkg>/fixtures/`。
 * 测试可用 `setFixtureRoot` 临时覆盖（例如在 monorepo 别处复用）。
 *
 * 路径解析显式落到 `fileURLToPath(import.meta.url)`，不依赖 `process.cwd()`，
 * 这样无论从哪里 `npx vitest`，都指向同一份 fixture 文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** `<server-root>/fixtures` 绝对路径 */
const DEFAULT_FIXTURE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
);

let fixtureRoot = DEFAULT_FIXTURE_ROOT;

export function setFixtureRoot(absPath: string): void {
  if (!path.isAbsolute(absPath)) {
    throw new Error(`[load-fixture] setFixtureRoot needs absolute path, got: ${absPath}`);
  }
  fixtureRoot = absPath;
}

export function resetFixtureRoot(): void {
  fixtureRoot = DEFAULT_FIXTURE_ROOT;
}

export function getFixtureRoot(): string {
  return fixtureRoot;
}

export function fixturePath(relative: string): string {
  if (path.isAbsolute(relative)) {
    throw new Error(`[load-fixture] fixturePath expects relative path, got: ${relative}`);
  }
  return path.join(fixtureRoot, relative);
}

export function loadFixture(relative: string): string {
  const fp = fixturePath(relative);
  if (!fs.existsSync(fp)) {
    throw new Error(`[load-fixture] missing fixture: ${fp}`);
  }
  return fs.readFileSync(fp, 'utf8');
}

export function loadFixtureJson<T = unknown>(relative: string): T {
  return JSON.parse(loadFixture(relative)) as T;
}

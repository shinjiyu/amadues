/**
 * 持久化原语：原子写 JSON / 创建目录。
 *
 * chat-server 用 JSON 文件做持久化（仿 Kuroneko `threads.json` 风格）。零依赖、可 inspect。
 *
 * 单点写入（每次写都覆盖），并发安全靠 `fs.writeFile` 的原子 rename：
 * - 先写到 `<file>.tmp`
 * - 再 rename 到目标
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

export function ensureDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export async function readJsonOr<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fsp.readFile(file, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw e;
  }
}

export function readJsonOrSync<T>(file: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw e;
  }
}

export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await fsp.rename(tmp, file);
}

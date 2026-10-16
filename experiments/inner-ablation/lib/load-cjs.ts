import fs from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

/** 在隔离上下文里加载工作目录里的 CommonJS 文件（不走 require 缓存，每次都读最新内容） */
export function loadCjs<T>(file: string, timeoutMs = 2000): T {
  const code = fs.readFileSync(file, 'utf8');
  const mod: { exports: unknown } = { exports: {} };
  const sandbox = {
    module: mod,
    exports: mod.exports,
    require: createRequire(file),
    console,
    Math,
    JSON,
    Number,
    Array,
    Object,
    globalThis: {} as Record<string, unknown>,
  };
  vm.runInNewContext(code, sandbox, { filename: file, timeout: timeoutMs });
  return mod.exports as T;
}

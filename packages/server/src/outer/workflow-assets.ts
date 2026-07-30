/**
 * EW assets（W13）：打包相对脚本 + execute 物化。
 * @see doc/structurizr/EXECUTABLE-WORKFLOW.md §6.1 W13
 */
import fs from 'node:fs';
import path from 'node:path';
import type { WorkflowAsset, WorkflowStep } from './executable-workflow-types.js';

export const EW_ASSET_MAX_BYTES = 512 * 1024;
export const EW_ASSETS_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
export const EW_ASSET_EXT = new Set(['.py', '.sh', '.js', '.mjs', '.cjs', '.ts', '.json']);

function assetError(message: string): Error {
  const e = new Error(message);
  e.name = 'WorkflowAssetError';
  return e;
}

/** 从 shell command 抽出相对脚本路径（仅解释器参数 / 可执行脚本，不含重定向目标） */
export function extractShellScriptRefs(command: string): string[] {
  const found = new Set<string>();
  // python/node/bash 后的脚本参数
  const interp =
    /(?:^|[\s;|&])(?:python3?|node|nodejs|bash|sh)\s+(['"]?)([^\s|&;'"]+\.(?:py|js|mjs|cjs|ts|sh))\1/gi;
  let m: RegExpExecArray | null;
  while ((m = interp.exec(command)) !== null) {
    const raw = (m[2] ?? '').trim();
    if (!raw || raw.startsWith('-')) continue;
    if (path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) continue;
    const norm = raw.replace(/\\/g, '/').replace(/^\.\//, '');
    if (EW_ASSET_EXT.has(path.extname(norm).toLowerCase())) found.add(norm);
  }
  // 直接执行 .run/ew/*.py|sh|js…（非重定向：前面不能是 > 或 >>）
  const direct =
    /(?:^|[\s;|&])(?<![>])((?:\.\/)?\.run\/ew\/[^\s|&;>]+\.(?:py|js|mjs|cjs|ts|sh))/gi;
  while ((m = direct.exec(command)) !== null) {
    const raw = (m[1] ?? '').trim();
    if (!raw) continue;
    const norm = raw.replace(/\\/g, '/').replace(/^\.\//, '');
    found.add(norm);
  }
  return [...found];
}

export function collectScriptRefsFromSteps(steps: WorkflowStep[]): string[] {
  const all = new Set<string>();
  for (const s of steps) {
    if (s.action !== 'shell') continue;
    const cmd = typeof s.args?.['command'] === 'string' ? String(s.args['command']) : '';
    for (const r of extractShellScriptRefs(cmd)) all.add(r);
  }
  return [...all];
}

function assertSafeAssetPath(rel: string): string {
  const norm = rel.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!norm || path.isAbsolute(norm) || /^[a-zA-Z]:[\\/]/.test(norm)) {
    throw assetError(`asset path 必须相对 workDir（W13）：${rel}`);
  }
  if (norm.split('/').includes('..')) {
    throw assetError(`asset path 禁止 ..（W13）：${rel}`);
  }
  return norm;
}

/**
 * 从 workDir 读取 steps 引用的脚本，合并进已有 assets。
 */
export function collectWorkflowAssetsFromWorkDir(
  steps: WorkflowStep[],
  workDir: string,
  existing?: WorkflowAsset[],
): WorkflowAsset[] {
  const byPath = new Map<string, WorkflowAsset>();
  for (const a of existing ?? []) {
    const p = assertSafeAssetPath(a.path);
    byPath.set(p, { path: p, content: a.content });
  }

  const root = path.resolve(workDir);
  let total = [...byPath.values()].reduce((n, a) => n + Buffer.byteLength(a.content, 'utf8'), 0);

  for (const rel of collectScriptRefsFromSteps(steps)) {
    if (byPath.has(rel)) continue;
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root)) {
      throw assetError(`asset 逃出 workDir（W13）：${rel}`);
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw assetError(
        `shell 引用脚本缺失，无法打包（W13）：${rel}（请放在 workspace 相对路径下再 promote）`,
      );
    }
    const content = fs.readFileSync(abs, 'utf8');
    const size = Buffer.byteLength(content, 'utf8');
    if (size > EW_ASSET_MAX_BYTES) {
      throw assetError(`asset 过大（W13）：${rel} ${size}B > ${EW_ASSET_MAX_BYTES}B`);
    }
    total += size;
    if (total > EW_ASSETS_MAX_TOTAL_BYTES) {
      throw assetError(`assets 总量过大（W13）> ${EW_ASSETS_MAX_TOTAL_BYTES}B`);
    }
    byPath.set(rel, { path: rel, content });
  }

  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** 引用了相对脚本则必须出现在 assets */
export function assertScriptsBundled(
  steps: WorkflowStep[],
  assets: WorkflowAsset[] | undefined,
): void {
  const refs = collectScriptRefsFromSteps(steps);
  if (refs.length === 0) return;
  const have = new Set((assets ?? []).map((a) => assertSafeAssetPath(a.path)));
  const missing = refs.filter((r) => !have.has(r));
  if (missing.length > 0) {
    throw assetError(
      `shell 引用脚本未打包进 assets（W13）：${missing.join(', ')}；promote 时提供 workDir 或显式 assets`,
    );
  }
}

/** execute 前写入 workDir */
export function materializeWorkflowAssets(
  assets: WorkflowAsset[] | undefined,
  workDir: string,
): string[] {
  if (!assets || assets.length === 0) return [];
  const root = path.resolve(workDir);
  const written: string[] = [];
  for (const a of assets) {
    const rel = assertSafeAssetPath(a.path);
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root)) {
      throw new Error(`asset escapes workDir: ${rel}`);
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, a.content, 'utf8');
    written.push(rel);
  }
  return written;
}

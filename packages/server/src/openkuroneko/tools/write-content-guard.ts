/**
 * write_file 内容校验与 ReAct slim 引用格式（避免模型复述占位符落盘）。
 *
 * ADL：doc/structurizr/DYFLOW-INNER-EXECUTOR.md §6.5
 */

import path from 'node:path';

/** 旧版 slim 占位（历史日志/模型误复述） */
const LEGACY_SLIM_PATTERN = /^\[\d+ chars omitted\b/i;

/** 新版 assistant 参数瘦身引用（不可作为 write_file content） */
export const SLIM_REF_PREFIX = '__SLIM_REF__:';

export const SLIM_EDIT_OLD_PREFIX = '__SLIM_EDIT_OLD__:';
export const SLIM_EDIT_NEW_PREFIX = '__SLIM_EDIT_NEW__:';

export function formatSlimWriteFileRef(filePath: string): string {
  return `${SLIM_REF_PREFIX}${filePath}`;
}

export function formatSlimEditRef(kind: 'old' | 'new', charLen: number): string {
  return kind === 'old'
    ? `${SLIM_EDIT_OLD_PREFIX}${charLen}`
    : `${SLIM_EDIT_NEW_PREFIX}${charLen}`;
}

/** write_file content 是否为框架 slim 占位或误复述的占位符 */
export function isRejectedWriteContent(content: string): boolean {
  const t = content.trim();
  if (!t) return false;
  if (t.startsWith(SLIM_REF_PREFIX)) return true;
  return LEGACY_SLIM_PATTERN.test(t);
}

export const REJECTED_WRITE_CONTENT_MSG =
  'content looks like a ReAct slim placeholder, not real file body. ' +
  'Use read_file to load from disk, or generate the full chapter/script text. ' +
  'Do not copy __SLIM_REF__ or [N chars omitted…] into write_file.';

export const REJECTED_OVERWRITE_MSG =
  'overwrite to this path already succeeded in this node. ' +
  'Use edit_file for small patches or write_file with mode=append. ' +
  'Use read_file to verify on-disk content first.';

function readEnvFlag(name: string, defaultEnabled: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  if (raw === '1' || raw === 'true' || raw === 'on') return true;
  return defaultEnabled;
}

/** write_file/edit_file 参数瘦身（__SLIM_REF__）；INNER_TOOL_ARGS_SLIM=0 关闭 */
export function isToolArgsSlimEnabled(): boolean {
  return readEnvFlag('INNER_TOOL_ARGS_SLIM', true);
}

/** 节点内同路径二次 overwrite 门禁；INNER_WRITE_FILE_OVERWRITE_GUARD=0 关闭 */
export function isWriteFileOverwriteGuardEnabled(): boolean {
  return readEnvFlag('INNER_WRITE_FILE_OVERWRITE_GUARD', true);
}

/** 节点内同路径 overwrite 去重用的相对路径键 */
export function normalizeWorkRelPath(workDir: string, filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed) return '';
  const abs = path.isAbsolute(trimmed) ? trimmed : path.join(workDir, trimmed);
  return path.relative(workDir, abs).split(path.sep).join('/');
}

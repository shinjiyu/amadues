/**
 * baseNode 常驻运行时环境块（system prompt 后缀）。
 *
 * ADL：doc/structurizr/DYFLOW-INNER-EXECUTOR.md §6.1b
 */

import os from 'node:os';
import path from 'node:path';

export interface RuntimeContextInput {
  workDir: string;
  /** 默认 process.env['UTLRA_DATA_ROOT'] */
  dataRoot?: string;
}

function resolveShellLabel(): string {
  if (process.platform !== 'win32') return 'posix (shell: true via spawn)';
  const pref = process.env['UTLRA_SHELL']?.trim().toLowerCase();
  if (pref === 'cmd') return 'cmd (UTLRA_SHELL=cmd)';
  return 'powershell (-NoProfile -NonInteractive -Command)';
}

/** 仅列存在的环境变量名（不含 secret 值） */
function listNotableEnvKeyNames(): string[] {
  const keys = Object.keys(process.env).filter(Boolean);
  const notable = keys.filter((k) => {
    const u = k.toUpperCase();
    return (
      u.includes('POKEMON') ||
      u.includes('SHOWDOWN') ||
      u.endsWith('_API_KEY') ||
      u.endsWith('_SECRET') ||
      u.endsWith('_TOKEN') ||
      k === 'USERNAME' ||
      k === 'USERPROFILE' ||
      k === 'HOME'
    );
  });
  return [...new Set(notable)].sort();
}

/**
 * 追加到 baseNode system prompt 的稳定环境块（每节点相同，便于前缀 cache）。
 */
export function buildRuntimeContextSection(input: RuntimeContextInput): string {
  const dataRoot = input.dataRoot?.trim() || process.env['UTLRA_DATA_ROOT']?.trim() || '';
  const vaultPath = dataRoot
    ? path.join(dataRoot, 'vault', 'blocks', 'keychain').replace(/\\/g, '/')
    : '（UTLRA_DATA_ROOT 未设置，vault 不可用）';
  const user = os.userInfo();
  const envKeys = listNotableEnvKeyNames();
  const shell = resolveShellLabel();

  const credentialRules = [
    '账号/密码以本节点 instruction 与 memory.goal 中的**明文**为准（外脑/Designer 已写入）；直接用于登录或脚本，勿再盲探。',
    'vault keychain 是外脑长期保管，**不是**加密传输：仅当 instruction 明确要求「从 vault key X 读取」且 goal 无明文时，才用 keychain_get。',
    '**禁止**：解密 Edge/Chrome Login Data、SQLite 爬浏览器密码、macOS security find-generic-password、无依据的 env/cmdkey 扫描。',
    'Windows 上 shell_exec 走 PowerShell：勿用 bash 语法（||、$_.Prop 在 -Command 中易被吃掉）。',
    '环境/凭据探测优先 shell_probe（多条命令一次返回），大文件用 read_file(offset_line, limit_lines)。',
    '截图/栅格图（.png 等）勿 read_file（会拒二进制）；用 describe_image(path, prompt?) 调 vision 模型得文字描述。',
    '大段代码 write_file 同路径仅一次 overwrite；后续 edit_file 或 append。勿把 __SLIM_REF__ / [N chars omitted…] 当作 write_file content。',
    'UI 自动化：browser_open → browser_act（探索）或 browser_run_steps（稳定脚本/playbook）→ browser_close；勿 write_file Playwright 脚本再 shell_exec。截图用 describe_image。',
    'web_search fetch 有字数上限；稳定结论用 record_fact，避免重复试探。',
  ];

  return [
    '## 运行时环境（框架注入，每轮 ReAct 均适用）',
    `- platform: ${process.platform} (${process.arch})`,
    `- shell: ${shell}`,
    `- user: ${user.username}`,
    `- home: ${user.homedir}`,
    `- workDir: ${input.workDir}`,
    `- dataRoot: ${dataRoot || '（未设置）'}`,
    `- vault keychain: ${vaultPath}`,
    `- notable env keys (names only): ${envKeys.length ? envKeys.join(', ') : '（无匹配项）'}`,
    '',
    '## 凭据与 shell 契约',
    ...credentialRules.map((l) => `- ${l}`),
  ].join('\n');
}

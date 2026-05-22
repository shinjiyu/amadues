/**
 * snapshot — 执行前后环境快照
 * 自动采集 workDir 目录结构和基本系统信息，写入 .brain/environment.md。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

/** 采集当前工作目录的环境快照，返回描述文本 */
export function captureSnapshot(workDir: string): string {
  const lines: string[] = [];
  lines.push(`# 环境快照`);
  lines.push(`时间：${new Date().toISOString()}`);
  lines.push('');

  // 工作目录文件列表
  lines.push('## 工作目录结构');
  try {
    const entries = fs.readdirSync(workDir, { withFileTypes: true });
    for (const e of entries) {
      const prefix = e.isDirectory() ? '[dir]' : '[file]';
      lines.push(`  ${prefix} ${e.name}`);
    }
  } catch (e) {
    lines.push(`  (无法读取: ${e})`);
  }
  lines.push('');

  // .brain/ 文件状态（记录各文件大小，便于归因时比对）
  lines.push('## .brain/ 文件状态');
  const brainDir = path.join(workDir, '.brain');
  const brainFiles = ['goal.md', 'milestones.md', 'constraints.md', 'knowledge.md', 'skills.md'];
  for (const f of brainFiles) {
    const fp = path.join(brainDir, f);
    if (fs.existsSync(fp)) {
      const stat = fs.statSync(fp);
      lines.push(`  ${f}: ${stat.size} bytes`);
    } else {
      lines.push(`  ${f}: (不存在)`);
    }
  }
  lines.push('');

  // 尝试获取 git 状态（仅供参考，失败时跳过）
  // 注意：原写法 `2>/dev/null` 是 POSIX 语法，Windows cmd 下会把 stderr 重定向到 /dev/null
  // 路径并打印「系统找不到指定的路径」。改用 stdio 抑制 stderr，跨平台。
  try {
    const gitStatus = execSync('git status --short', {
      cwd: workDir,
      timeout: 3000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (gitStatus) {
      lines.push('## Git 状态');
      lines.push(gitStatus.split('\n').map(l => `  ${l}`).join('\n'));
      lines.push('');
    }
  } catch {
    // 非 git 目录或无 git 命令，忽略
  }

  return lines.join('\n');
}

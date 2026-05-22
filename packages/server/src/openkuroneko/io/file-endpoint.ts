/**
 * 文件型 I/O 端点实现
 *
 * Input：基于 offset 增量读取（消费语义），offset 持久化到旁路文件。
 * Output：追加写入（append 语义）。外脑 push-loop 基于 offset 增量读取，
 *         若覆写文件会导致 offset 错位、截断 JSON，因此改为追加。
 */

import fs from 'node:fs';
import type { InputEndpoint, OutputEndpoint } from './index.js';

export function createFileInputEndpoint(id: string, filePath: string): InputEndpoint {
  // offset 持久化到旁路文件，进程重启后不重复读取已消费内容
  const offsetFile = `${filePath}.offset`;

  function readOffset(): number {
    try {
      return parseInt(fs.readFileSync(offsetFile, 'utf8'), 10) || 0;
    } catch {
      return 0;
    }
  }

  function writeOffset(n: number): void {
    fs.writeFileSync(offsetFile, String(n), 'utf8');
  }

  return {
    id,
    async read(): Promise<string | null> {
      if (!fs.existsSync(filePath)) return null;
      const stat = fs.statSync(filePath);
      const offset = readOffset();
      if (stat.size <= offset) return null; // no new bytes

      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(stat.size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      writeOffset(stat.size);

      const content = buf.toString('utf8').trim();
      return content || null;
    },
  };
}

export function createFileOutputEndpoint(id: string, filePath: string): OutputEndpoint {
  return {
    id,
    async write(content: string): Promise<void> {
      // 追加写入：外脑 push-loop 用 offset 增量读取，覆写会导致 offset 错位截断内容
      fs.appendFileSync(filePath, content + '\n', 'utf8');
    },
  };
}

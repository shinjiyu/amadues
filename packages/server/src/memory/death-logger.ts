/**
 * 持久化死亡日志写入器
 *
 * 当心跳检测判定 agent 死亡时，将 DeathRecord 写入 JSONL 文件。
 * 采用追加模式（append），路径可配置。
 *
 * 职责边界：
 * - 只负责「死亡时写入日志」
 * - 不包含心跳检测判断逻辑
 * - 使用文件系统 JSONL 存储（不引入数据库）
 */

import * as fs from 'fs';
import * as path from 'path';
import type { DeathRecord } from './types.js';

/**
 * 死亡日志选项
 */
export interface DeathLoggerOptions {
  /** 日志文件输出路径，默认 "./memory-death-log.jsonl" */
  logPath?: string;
}

/**
 * 持久化死亡日志写入器
 */
export class DeathLogger {
  private readonly logPath: string;

  constructor(options: DeathLoggerOptions = {}) {
    this.logPath = options.logPath ?? './memory-death-log.jsonl';
  }

  /**
   * 获取日志文件路径
   */
  getLogPath(): string {
    return this.logPath;
  }

  /**
   * 写入一条死亡记录（JSONL 追加模式）
   *
   * @param record - 死亡记录
   */
  async writeDeathLog(record: DeathRecord): Promise<void> {
    const dir = path.dirname(this.logPath);

    // 确保目录存在
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const line = JSON.stringify(record) + '\n';

    // 追加写入
    await fs.promises.appendFile(this.logPath, line, 'utf-8');
  }

  /**
   * 读取所有死亡记录
   *
   * @param agentId - 可选，按 agentId 过滤
   */
  async readAllDeathLogs(agentId?: string): Promise<DeathRecord[]> {
    const allRecords = await this.readAllRaw();
    if (agentId) {
      return allRecords.filter((r) => r.agentId === agentId);
    }
    return allRecords;
  }

  /**
   * 读取最近一条死亡记录
   *
   * @param agentId - 可选，按 agentId 过滤
   */
  async readLatestDeathLog(agentId?: string): Promise<DeathRecord | null> {
    const records = await this.readAllDeathLogs(agentId);
    if (records.length === 0) {
      return null;
    }
    return records[records.length - 1];
  }

  /**
   * 获取死亡记录总数
   *
   * @param agentId - 可选，按 agentId 过滤
   */
  async countDeathLogs(agentId?: string): Promise<number> {
    const records = await this.readAllDeathLogs(agentId);
    return records.length;
  }

  /**
   * 清除所有死亡记录
   */
  async clearAll(): Promise<void> {
    try {
      await fs.promises.unlink(this.logPath);
    } catch (err: unknown) {
      // 文件不存在时忽略
      if (
        err instanceof Error &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code !== 'ENOENT'
      ) {
        throw err;
      }
    }
  }

  /**
   * 读取原始日志文件的所有行，解析为 DeathRecord 数组
   */
  private async readAllRaw(): Promise<DeathRecord[]> {
    try {
      const content = await fs.promises.readFile(this.logPath, 'utf-8');
      const lines = content.split('\n').filter((line) => line.trim() !== '');
      const records: DeathRecord[] = [];
      for (const line of lines) {
        try {
          records.push(JSON.parse(line) as DeathRecord);
        } catch {
          // 跳过解析失败的行
          continue;
        }
      }
      return records;
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return [];
      }
      throw err;
    }
  }
}

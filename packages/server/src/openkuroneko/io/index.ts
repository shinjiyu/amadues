/**
 * M3 · I/O Interface Registry
 *
 * 职责：
 * - 维护 endpoint 注册表（id → InputEndpoint / OutputEndpoint）
 * - 单生产者-单消费者约束
 * - 支持启动时指定与运行时注册
 * - 具体实现：文件型（默认）、内存型（测试）
 *
 * 协议文档：doc/protocols/io-endpoint.md（待建）
 */

export interface InputEndpoint {
  id: string;
  /** 读取并消费（consume）输入；无内容时返回 null */
  read(): Promise<string | null>;
}

export interface OutputEndpoint {
  id: string;
  /** 写入输出（覆盖语义） */
  write(content: string): Promise<void>;
}

export interface IORegistry {
  registerInput(ep: InputEndpoint): void;
  registerOutput(ep: OutputEndpoint): void;
  getInput(id: string): InputEndpoint | undefined;
  getOutput(id: string): OutputEndpoint | undefined;
  listInputs(): string[];
  listOutputs(): string[];
}

export { createIORegistry } from './registry.js';
export { createFileInputEndpoint, createFileOutputEndpoint } from './file-endpoint.js';

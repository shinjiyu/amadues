import type { Tool } from '../index.js';

/**
 * read_write_structured_state — 读写 TASKS 状态
 * 实际操作委托给 Runner 注入的 memoryLayer2 实例。
 */
let _readTasks: (() => string) | null = null;
let _writeTasks: ((content: string) => void) | null = null;

export function setStateAccessors(
  read: () => string,
  write: (content: string) => void
): void {
  _readTasks = read;
  _writeTasks = write;
}

export const readWriteStateTool: Tool = {
  name: 'read_write_structured_state',
  description: 'Read or overwrite the TASKS structured state file.',
  async call(args) {
    const action = String(args['action'] ?? 'read');
    if (action === 'read') {
      if (!_readTasks) return { ok: false, output: 'State accessor not initialized' };
      return { ok: true, output: _readTasks() };
    }
    if (action === 'write') {
      if (!_writeTasks) return { ok: false, output: 'State accessor not initialized' };
      const content = String(args['content'] ?? '');
      _writeTasks(content);
      return { ok: true, output: 'TASKS updated' };
    }
    return { ok: false, output: `Unknown action: ${action}` };
  },
};

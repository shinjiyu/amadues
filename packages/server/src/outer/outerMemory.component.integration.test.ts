/**
 * ADL component: outerMemory — tasks 缓存读写（无 mem9）
 */
import { describe, expect, it } from 'vitest';

import { OuterMemoryStore } from './outer-memory.js';

describe('component: outerMemory', () => {
  it('无 mem9 时 readChatLog 返回提示（主路径）', async () => {
    const store = new OuterMemoryStore(null, 'kuro');
    const log = await store.readChatLog();
    expect(log).toContain('MEM9');
  });

  it('writeTasks / readTasks 内存往返', () => {
    const store = new OuterMemoryStore(null, 'kuro');
    store.writeTasks('- [ ] 任务 A');
    expect(store.readTasks()).toContain('任务 A');
  });
});

/**
 * ADL component: outerMemory + belief reconcile
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { OuterMemoryStore } from './outer-memory.js';

describe('component: outerMemory', () => {
  let root: string;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

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

  it('reconcileFromUserMessage 更新 tasks 并持久化 belief', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'om-belief-'));
    const store = new OuterMemoryStore(null, 'kuro', root);
    store.writeTasks('- [ ] 微博调研');
    const r = store.reconcileFromUserMessage('微博调研不要做了', 'human:u1');
    expect(r.applied).toBe(true);
    expect(store.readTasks()).toContain('[cancelled]');
    const beliefFile = path.join(root, 'belief', 'kuro.json');
    expect(fs.existsSync(beliefFile)).toBe(true);
  });
});

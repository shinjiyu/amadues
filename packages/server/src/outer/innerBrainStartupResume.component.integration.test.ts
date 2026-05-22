/**
 * ADL component: innerBrainStartupResume — 磁盘 registry + 启动恢复主路径
 * @see doc/structurizr/INNER-BRAIN-RESUME.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestDataRoot, type TestDataRoot } from '../testing/temp-data-root.js';
import { InnerBrainRegistry, type TaskRecord } from './inner-brain-registry.js';
import { autoResumeStaleTasks } from './inner-brain-startup-resume.js';

describe('component: innerBrainStartupResume', () => {
  let root: TestDataRoot;

  afterEach(() => {
    root?.cleanup();
  });

  it('模拟外脑重启：持久化 RUNNING → 新 registry 实例 → resume 同一 instanceId', () => {
    root = createTestDataRoot('ibsr-');
    const workDir = path.join(root.workspacesDir, 'task-ib-persist');
    fs.mkdirSync(path.join(workDir, '.brain'), { recursive: true });

    const record: TaskRecord = {
      instanceId: 'ib-persist-01',
      workspaceId: 'task-ib-persist',
      workDir,
      goal: 'persist goal',
      originUser: 'u1',
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
      pid: 99_999,
    };

    const beforeCrash = new InnerBrainRegistry(root.dataRoot);
    beforeCrash.register(record);

    // 模拟 agentServer 进程重启：新 InnerBrainRegistry 从同一 dataRoot 加载
    const afterRestart = new InnerBrainRegistry(root.dataRoot);
    expect(afterRestart.get('ib-persist-01')?.status).toBe('RUNNING');

    const spawned: string[] = [];
    autoResumeStaleTasks(
      afterRestart,
      (r, opts) => {
        spawned.push(r.instanceId);
        afterRestart.update(r.instanceId, {
          status: 'RUNNING',
          pid: 12_345,
          resumeCount: (r.resumeCount ?? 0) + (opts.incrementResumeCount ? 1 : 0),
        });
        return { ok: true, pid: 12_345 };
      },
      { enabled: true, maxResumes: 3 },
    );

    expect(spawned).toEqual(['ib-persist-01']);
    const final = afterRestart.get('ib-persist-01');
    expect(final?.status).toBe('RUNNING');
    expect(final?.resumeCount).toBe(1);
    expect(final?.workDir).toBe(workDir);

    // 第三次「重启」加载应看到 resumeCount 累积
    const thirdLoad = new InnerBrainRegistry(root.dataRoot);
    expect(thirdLoad.get('ib-persist-01')?.resumeCount).toBe(1);
  });

  it('UTLRA_INNER_AUTO_RESUME=0 语义：仅 STOPPED，不 spawn', () => {
    root = createTestDataRoot('ibsr-off-');
    const reg = new InnerBrainRegistry(root.dataRoot);
    reg.register({
      instanceId: 'ib-off-01',
      workspaceId: 'ws-off',
      workDir: path.join(root.workspacesDir, 'ws-off'),
      goal: 'g',
      originUser: 'u1',
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
    });

    let spawned = false;
    autoResumeStaleTasks(
      reg,
      () => {
        spawned = true;
        return { ok: true, pid: 1 };
      },
      { enabled: false, maxResumes: 3 },
    );

    expect(spawned).toBe(false);
    expect(reg.get('ib-off-01')?.status).toBe('STOPPED');
  });
});

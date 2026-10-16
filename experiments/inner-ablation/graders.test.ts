/**
 * 判分器自证：每个真实任务「原 fixture 判不过 + 叠参考解判得过」，保护文件 hash 不被参考解改动。
 * 运行：npx --yes tsx --test experiments/inner-ablation/graders.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { copyDir, freePort, hashFiles } from './lib/fs-util.ts';
import { REAL_TASKS } from './tasks/index.ts';
import type { AblationTask } from './types.ts';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ablation-graders-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

async function prepare(task: AblationTask, label: string, withReference: boolean) {
  const workDir = path.join(tmpRoot, `${task.id}-${label}`);
  copyDir(task.fixtureDir, workDir);
  const params = { port: await freePort() };
  const before = hashFiles(workDir, task.protectedFiles);
  if (withReference) {
    if (task.referenceDir) fs.cpSync(task.referenceDir, workDir, { recursive: true });
    await task.applyReference?.(workDir, params);
  }
  return { workDir, params, before };
}

describe('ablation graders', () => {
  for (const task of REAL_TASKS) {
    describe(task.id, () => {
      it('protected files exist in fixture', () => {
        const h = hashFiles(task.fixtureDir, task.protectedFiles);
        for (const [rel, v] of Object.entries(h)) assert.ok(v, `missing protected file ${rel}`);
      });

      it('has a reference solution', () => {
        assert.ok(task.referenceDir || task.applyReference);
      });

      it('untouched fixture fails', async () => {
        const { workDir, params } = await prepare(task, 'fixture', false);
        try {
          const g = await task.grade(workDir, params);
          assert.equal(g.pass, false, JSON.stringify(g.checks));
        } finally {
          await task.cleanup?.(workDir, params);
        }
      });

      it('fixture + reference passes without touching protected files', async () => {
        const { workDir, params, before } = await prepare(task, 'ref', true);
        try {
          assert.deepEqual(hashFiles(workDir, task.protectedFiles), before);
          const g = await task.grade(workDir, params);
          assert.equal(g.pass, true, JSON.stringify(g.checks));
        } finally {
          await task.cleanup?.(workDir, params);
        }
      });
    });
  }
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { makeShellExecutor } from './ports.ts';
import { captureStages, enforceStageGate, stageViolation } from './stage-gate.ts';
import { buildStagedCorpus, resetStagedOutput } from './tasks-staged.ts';
import { verifyTask } from './tasks.ts';

describe('stage gate', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-gate-'));
    dirs.push(d);
    fs.mkdirSync(path.join(d, 'work'), { recursive: true });
    return d;
  };

  it('rejects one command that writes every stage, and rolls back', () => {
    const dir = tmp();
    const before = captureStages(dir);
    fs.writeFileSync(path.join(dir, 'work', 's1.txt'), 'a\n');
    fs.writeFileSync(path.join(dir, 'work', 's2.txt'), 'b\n');
    fs.writeFileSync(path.join(dir, 'out.csv'), 'b\n');
    const verdict = enforceStageGate(dir, before);
    assert.equal(verdict.ok, false);
    assert.match(verdict.ok ? '' : verdict.observation, /more than one/);
    assert.equal(fs.existsSync(path.join(dir, 'out.csv')), false);
    assert.equal(fs.existsSync(path.join(dir, 'work', 's1.txt')), false);
  });

  it('rejects out.csv before both stages exist', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'work', 's1.txt'), 'MARK k0i00 900\n');
    const before = captureStages(dir);
    fs.writeFileSync(path.join(dir, 'out.csv'), 'k0i00\n');
    const msg = stageViolation(before, captureStages(dir));
    assert.match(msg ?? '', /out.csv before both/);
  });

  it('accepts s1, then s2, then out.csv as three commands', async () => {
    const dir = tmp();
    const { tasks } = buildStagedCorpus(dir, 1);
    const exec = makeShellExecutor(dir, { stageGate: true });
    const k = 0;
    const steps = [
      `grep MARK inbox/batch-${k}.txt | tee work/s1.txt`,
      `awk '$3+0 > 500 {print $2}' work/s1.txt | tee work/s2.txt`,
      `LC_ALL=C sort work/s2.txt > out.csv`,
    ];
    for (const command of steps) {
      const res = await exec({ name: 'shell_exec', args: { command } });
      assert.equal(res.ok, true, res.observation);
    }
    assert.equal(verifyTask(dir, tasks[0]), true);

    resetStagedOutput(dir);
    const collapsed = await exec({
      name: 'shell_exec',
      args: {
        command:
          `grep MARK inbox/batch-${k}.txt > work/s1.txt && ` +
          `awk '$3+0 > 500 {print $2}' work/s1.txt > work/s2.txt && ` +
          `LC_ALL=C sort work/s2.txt > out.csv`,
      },
    });
    assert.equal(collapsed.ok, false);
    assert.match(collapsed.observation, /rolled back/);
    assert.equal(fs.existsSync(path.join(dir, 'out.csv')), false);
    assert.equal(verifyTask(dir, tasks[0]), false);
  });
});

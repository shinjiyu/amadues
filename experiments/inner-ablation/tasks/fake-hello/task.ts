import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gradeFrom, type AblationTask } from '../../types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

export const FAKE_HELLO_FILE = 'hello.txt';
export const FAKE_HELLO_TEXT = 'hello ablation';

/** 只给 --fake 冒烟用：验证编排、隔离、判分、指标链路，不衡量能力 */
export const fakeHello: AblationTask = {
  id: 'fake-hello',
  source: { instanceIds: [], summary: '冒烟玩具任务' },
  fixtureDir: path.join(here, 'fixture'),
  protectedFiles: ['README.txt'],
  goal: () => `在工作目录写 ${FAKE_HELLO_FILE}，内容为「${FAKE_HELLO_TEXT}」。`,
  async grade(workDir) {
    const file = path.join(workDir, FAKE_HELLO_FILE);
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null;
    return gradeFrom([{ name: 'hello_written', ok: text === FAKE_HELLO_TEXT, detail: String(text) }]);
  },
};

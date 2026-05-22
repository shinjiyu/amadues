/**
 * 隔离的临时 dataRoot — 所有 harness / integration 测试应从这里起步。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface TestDataRoot {
  dataRoot: string;
  workspacesDir: string;
  cleanup: () => void;
}

export function createTestDataRoot(prefix = 'kuroneko-test-'): TestDataRoot {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workspacesDir = path.join(dataRoot, 'workspaces');
  fs.mkdirSync(workspacesDir, { recursive: true });
  return {
    dataRoot,
    workspacesDir,
    cleanup: () => {
      try {
        fs.rmSync(dataRoot, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { compressToolOutputForContext, spillToolOutput } from './tool-output-spill.js';

describe('tool-output-spill', () => {
  let workDir: string;

  afterEach(() => {
    if (workDir && fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('spills large output and hints read_file path', () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spill-'));
    const big = 'x'.repeat(8000);
    const compressed = compressToolOutputForContext(big, {
      inlineMax: 3000,
      spill: { workDir, round: 2, toolName: 'shell_exec', toolCallId: 'tc1' },
    });
    expect(compressed).toContain('.run/tool-output/');
    expect(compressed).toContain('read_file');
    expect(compressed.length).toBeLessThan(big.length);
  });
});

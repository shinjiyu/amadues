import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalNodeStore } from './local-node-store.js';
import { createMemoryStore } from './memory-store.js';
import { seedPresetNodes } from './preset-seeder.js';
import { createDesignerTools } from './designer-tools.js';
import { writeBurstModeMarker } from './workflow-runner.js';

describe('designer execute 禁 redesign', () => {
  let root: string;

  afterEach(() => {
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('burstMode=execute 时 commit_local_dag 拒收', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-des-'));
    const store = createLocalNodeStore(root);
    seedPresetNodes(root, { store });
    const memory = createMemoryStore(root);
    writeBurstModeMarker(root, {
      burstMode: 'execute',
      workflowRef: { id: 'ew-x', version: '1' },
    });
    const { registry } = createDesignerTools({
      store,
      memory,
      workDir: root,
      burstId: 'b1',
    });
    const tool = registry.get('commit_local_dag');
    expect(tool).toBeTruthy();
    const r = await tool!.call({
      nodes: [
        {
          id: 'n1',
          ref: 'preset/base',
          instruction: 'do',
          deliverable: { summary: 'x', checks: [{ kind: 'file', target: 'a.txt' }] },
        },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/禁止 redesign/);
  });
});

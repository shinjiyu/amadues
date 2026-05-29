import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readPeerFileTool } from './peer-file-tools.js';
import { writeFileTool } from './write-file.js';
import { setPeerWorkspaces, setWorkDirGuard } from './workdir-guard.js';

describe('readPeerFileTool', () => {
  let workDir = '';
  let peerDir = '';

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-read-wd-'));
    peerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-read-peer-'));
    fs.writeFileSync(path.join(peerDir, 'capability_map.md'), '# map', 'utf8');
    setWorkDirGuard(workDir, workDir, []);
    setPeerWorkspaces([{ workspaceId: 'task-ib-peer', workDir: peerDir }]);
  });

  afterEach(() => {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
    if (peerDir) fs.rmSync(peerDir, { recursive: true, force: true });
  });

  it('reads from registered peer workspace', async () => {
    const r = await readPeerFileTool.call({
      workspace_id: 'task-ib-peer',
      path: 'capability_map.md',
    });
    expect(r.ok).toBe(true);
    expect(r.output).toContain('# map');
  });

  it('rejects writing into peer workspace', async () => {
    const r = await writeFileTool.call({
      path: path.join(peerDir, 'evil.md'),
      content: 'nope',
    });
    expect(r.ok).toBe(false);
  });
});

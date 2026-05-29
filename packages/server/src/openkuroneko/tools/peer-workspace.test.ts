import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildPeerWorkspaceEntries,
  isValidWorkspaceId,
  resolvePeerWorkDir,
} from './peer-workspace.js';

describe('peer-workspace', () => {
  it('rejects path traversal in workspace id', () => {
    expect(isValidWorkspaceId('../evil')).toBe(false);
    expect(isValidWorkspaceId('task-ib-abc')).toBe(true);
  });

  it('resolvePeerWorkDir stays under workspaces root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-ws-'));
    try {
      const ws = path.join(root, 'task-ib-demo');
      fs.mkdirSync(ws, { recursive: true });
      fs.writeFileSync(path.join(ws, 'report.md'), 'ok', 'utf8');
      expect(resolvePeerWorkDir(root, 'task-ib-demo')).toBe(ws);
      expect(resolvePeerWorkDir(root, '../outside')).toBeNull();
      const entries = buildPeerWorkspaceEntries(root, ['task-ib-demo', 'missing']);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.workspaceId).toBe('task-ib-demo');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

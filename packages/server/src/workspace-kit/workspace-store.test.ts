import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FilesystemWorkspaceStore } from './workspace-store.js';

describe('FilesystemWorkspaceStore', () => {
  let root: string;
  let store: FilesystemWorkspaceStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'utlra-ws-'));
    store = new FilesystemWorkspaceStore(path.join(root, 'workspaces'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates manifest on ensureWorkspace', () => {
    store.ensureWorkspace('default');
    const m = store.readManifest('default');
    expect(m.schema).toBe('run-manifest.v1');
    expect(m.runId).toBe('default');
  });
});

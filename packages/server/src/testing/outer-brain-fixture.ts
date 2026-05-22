/**
 * OuterBrain 装配夹具：临时 dataRoot + FakeIm + ChatIRSeenTracker。
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  ChatAssetStore,
  ChatIRSeenTracker,
  IdentityRegistry,
  type LooseThreadStore,
} from '@utlra/chat-ir';
import { FilesystemRepositoryStore, FilesystemWorkspaceStore } from '../workspace-kit/index.js';
import { OuterBrain } from '../outer/outer-brain.js';
import { createTestDataRoot, type TestDataRoot } from './temp-data-root.js';
import { FakeImChannel } from './fake-im-channel.js';
import { createNoopEngine } from './agent-stack-fixture.js';

export interface OuterBrainFixture extends TestDataRoot {
  im: FakeImChannel;
  brain: OuterBrain;
  registry: IdentityRegistry;
  workspaceStore: FilesystemWorkspaceStore;
  repoStore: FilesystemRepositoryStore;
  assetStore: ChatAssetStore;
  seenTracker: ChatIRSeenTracker;
  loadThreads: () => LooseThreadStore;
  saveThreads: (data: LooseThreadStore) => void;
  agentSid: string;
}

export function createOuterBrainFixture(agentSid = 'agent:test-outer'): OuterBrainFixture {
  process.env['UTLRA_OUTER_JITTER_MIN_MS'] = '0';
  process.env['UTLRA_OUTER_JITTER_MAX_MS'] = '0';
  process.env['UTLRA_AGENT_IM_SID'] = agentSid;
  const root = createTestDataRoot('outer-brain-');
  const chatDir = path.join(root.dataRoot, 'chat');
  fs.mkdirSync(chatDir, { recursive: true });
  fs.mkdirSync(path.join(root.dataRoot, 'uploads'), { recursive: true });

  const identityFile = path.join(root.dataRoot, 'identities.json');
  const registry = new IdentityRegistry(identityFile);
  registry.upsert({
    schema: 'identity.v1',
    sid: agentSid,
    kind: 'agent',
    display_name: 'TestAgent',
    aliases: [],
    roles_in_tenant: ['agent'],
    bindings: [],
    updated_at: new Date().toISOString(),
  });
  registry.upsert({
    schema: 'identity.v1',
    sid: 'human:alice',
    kind: 'human',
    display_name: 'Alice',
    aliases: [],
    roles_in_tenant: ['member'],
    bindings: [],
    updated_at: new Date().toISOString(),
  });
  registry.save();

  const threadsPath = path.join(chatDir, 'threads.json');
  let threads: LooseThreadStore = { messages: {}, threads: [] };
  if (fs.existsSync(threadsPath)) {
    threads = JSON.parse(fs.readFileSync(threadsPath, 'utf8')) as LooseThreadStore;
  }
  const loadThreads = () => threads;
  const saveThreads = (data: LooseThreadStore) => {
    threads = data;
    fs.writeFileSync(threadsPath, JSON.stringify(data, null, 2), 'utf8');
  };

  const im = new FakeImChannel();
  const workspaceStore = new FilesystemWorkspaceStore(root.workspacesDir);
  const repoStore = new FilesystemRepositoryStore(root.dataRoot);
  const assetStore = new ChatAssetStore(path.join(root.dataRoot, 'uploads'));
  const seenTracker = new ChatIRSeenTracker({
    selfAgentSid: agentSid,
    identityRegistry: registry,
  });

  const brain = new OuterBrain({
    imClient: im,
    seenTracker,
    assetStore,
    registry,
    getEngine: () => createNoopEngine(),
    workspaceStore,
    repoStore,
    loadThreads,
    dataRoot: root.dataRoot,
  });

  return {
    ...root,
    im,
    brain,
    registry,
    workspaceStore,
    repoStore,
    assetStore,
    seenTracker,
    loadThreads,
    saveThreads,
    agentSid,
  };
}

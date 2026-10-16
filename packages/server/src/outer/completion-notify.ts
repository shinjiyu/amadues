/**
 * 工人交付登记后，把工作台上的文件收进给人的资产库。
 * 不发聊天消息。ADL: doc/structurizr/WORKSHOP.md §5
 */
import fs from 'node:fs';
import path from 'node:path';

import type { ChatAssetStore, ChatIRChannel } from '@utlra/chat-ir';
import type { DeliverableAsset, InnerBrainEngine } from '../workspace-kit/index.js';

import { ingestDeliverables } from './deliverables-ingest.js';

export interface CompletionNotifyDeps {
  imClient: ChatIRChannel;
  agentSid: string;
  assetStore: ChatAssetStore;
  getEngine: (workspaceId: string) => InnerBrainEngine;
}

function collectDeliverablePaths(workDir: string): string[] {
  const fp = path.join(workDir, '.run', 'pi-mono', 'deliverables.json');
  try {
    if (!fs.existsSync(fp)) return [];
    const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 产物吸收。不发送 postMessage。 */
export function ingestInnerBrainDeliverablesOnExit(
  deps: CompletionNotifyDeps,
  opts: { workspaceId: string; workDir: string },
): { assets: DeliverableAsset[]; deliverables: string[] } {
  const deliverables = collectDeliverablePaths(opts.workDir);
  const ingest = ingestDeliverables(opts.workDir, deliverables, deps.assetStore);
  try {
    deps.getEngine(opts.workspaceId).setDeliverables(ingest.assets);
  } catch (e) {
    console.error('[completion-notify] setDeliverables failed:', e);
  }
  return { assets: ingest.assets, deliverables };
}

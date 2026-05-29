import fs from 'node:fs';
import path from 'node:path';

import type { AutonomyDispatchResult, AutonomyTaskType, ResourceSnapshot } from './autonomy-types.js';

const LOG_DIR = 'autonomy';
const LOG_FILE = 'action-log.jsonl';

export interface AutonomyActionLogEntry {
  at: string;
  taskType?: AutonomyTaskType;
  dispatched: boolean;
  reason: string;
  detail?: string;
  snapshotSummary?: {
    running: number;
    awaiting: number;
    llmInFlight: number;
    tokens1h: number;
  };
}

export function appendAutonomyActionLog(dataRoot: string, entry: AutonomyActionLogEntry): void {
  const dir = path.join(dataRoot, LOG_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, LOG_FILE), JSON.stringify(entry) + '\n', 'utf8');
}

export function summarizeSnapshot(snapshot: ResourceSnapshot): AutonomyActionLogEntry['snapshotSummary'] {
  return {
    running: snapshot.innerBrains.running,
    awaiting: snapshot.innerBrains.awaiting,
    llmInFlight: snapshot.llm.inFlight,
    tokens1h: snapshot.llm.tokensLast1h.total,
  };
}

export function logAutonomyDispatch(
  dataRoot: string,
  snapshot: ResourceSnapshot,
  result: AutonomyDispatchResult,
): void {
  appendAutonomyActionLog(dataRoot, {
    at: new Date().toISOString(),
    taskType: result.taskType,
    dispatched: result.dispatched,
    reason: result.reason,
    detail: result.detail,
    snapshotSummary: summarizeSnapshot(snapshot),
  });
}

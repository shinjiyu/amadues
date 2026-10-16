import fs from 'node:fs';
import path from 'node:path';

const LOG_DIR = 'autonomy';
const LOG_FILE = 'action-log.jsonl';

export interface AutonomyActionLogEntry {
  at: string;
  dispatched: boolean;
  reason: string;
  detail?: string;
}

export function appendAutonomyActionLog(dataRoot: string, entry: AutonomyActionLogEntry): void {
  const dir = path.join(dataRoot, LOG_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, LOG_FILE), JSON.stringify(entry) + '\n', 'utf8');
}

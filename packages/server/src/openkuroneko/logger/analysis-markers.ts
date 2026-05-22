/**
 * 日志分析旁路 — 协议见 doc/protocols/logging.md §5.2
 */

import fs from 'node:fs';
import path from 'node:path';

export const ANALYSIS_MARKER_SCHEMA_VERSION = 1 as const;

export interface AnalysisMarkerRecord {
  schema_version: typeof ANALYSIS_MARKER_SCHEMA_VERSION;
  log_id: string;
  analyzed: boolean;
  analyzed_at: string;
  analyst?: string;
  notes?: string;
  labels?: string[];
}

export function appendAnalysisMarker(
  tempDir: string,
  record: Omit<AnalysisMarkerRecord, 'schema_version'>,
): void {
  const logsDir = path.join(tempDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const line: AnalysisMarkerRecord = {
    schema_version: ANALYSIS_MARKER_SCHEMA_VERSION,
    ...record,
  };
  const file = path.join(logsDir, 'analysis-markers.jsonl');
  fs.appendFileSync(file, JSON.stringify(line) + '\n', 'utf8');
}

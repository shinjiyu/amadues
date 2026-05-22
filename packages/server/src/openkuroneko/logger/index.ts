/**
 * M11 · Logger — 独立结构化日志模块
 *
 * 行格式与工程化字段见 doc/protocols/logging.md（v2：log_id、tags、analyzed）。
 * 物理路径：<tempDir>/logs/YYYY-MM-DD.jsonl
 */

export type {
  LogLevel,
  LogEntry,
  LogEventPayload,
  Logger,
  CreateLoggerOptions,
} from './types.js';
export { LOG_ENTRY_SCHEMA_VERSION } from './types.js';

export { createLogger } from './logger.js';
export { pruneOldLogs } from './logger.js';
export { appendAnalysisMarker, type AnalysisMarkerRecord, ANALYSIS_MARKER_SCHEMA_VERSION } from './analysis-markers.js';

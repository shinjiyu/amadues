/**
 * 日志类型 — 与 doc/protocols/logging.md 对齐
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_ENTRY_SCHEMA_VERSION = 2 as const;

export interface LogEventPayload {
  event: string;
  data?: unknown;
  tags?: string[];
  analyzed?: boolean;
  analyzed_at?: string;
}

export interface LogEntry {
  schema_version: typeof LOG_ENTRY_SCHEMA_VERSION;
  log_id: string;
  ts: string;
  level: LogLevel;
  module: string;
  agentId: string;
  event: string;
  tags?: string[];
  analyzed: boolean;
  analyzed_at?: string;
  data?: unknown;
}

export interface Logger {
  debug(module: string, payload: LogEventPayload): void;
  info(module: string, payload: LogEventPayload): void;
  warn(module: string, payload: LogEventPayload): void;
  error(module: string, payload: LogEventPayload): void;
}

export interface CreateLoggerOptions {
  retainDays?: number;
  defaultTags?: string[];
}

/**
 * 内脑产物 → chat IR asset 吸收器（协议：`doc/protocols/inner-brain-deliverables.md`）。
 *
 * 唯一被允许调用的位置：外脑 `onExit(DONE)` 分支（R4.1）。
 *
 * 输入：内脑 `COMPLETE` 事件携带的 `deliverables: string[]`（workspace 相对路径）。
 * 输出：`DeliverableAsset[]`（已写入 `ChatAssetStore`，可用 `asset:<uuid>` 引用）。
 *
 * 严格的协议约束：
 * - R4.3：单文件 > UTLRA_DELIVERABLE_MAX_BYTES（默认 25 MiB）= 跳过
 * - R4.4：读文件 / save 失败 = 跳过，不阻断整批
 * - R4.6：**不允许**走全目录扫描；未登记 = 不发
 * - R8.1：跳过事件写入 `<workDir>/.run/deliverables.log`
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ChatAssetStore } from '@utlra/chat-ir';
import type { DeliverableAsset } from '../workspace-kit/index.js';

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/** 由 mime 推断 chat IR 资产 kind。与 discord-bridge `attachmentKindFromMime` 对齐。 */
export function inferKindFromMime(mime: string): DeliverableAsset['kind'] {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

/**
 * 基于扩展名 + 简单 sniff 推断 mime。
 *
 * 不引外部库（chat IR runtime 不依赖 mime db）；够用即可，未识别返回 octet-stream。
 */
export function inferMimeByPath(absPath: string): string {
  const ext = path.extname(absPath).toLowerCase();
  switch (ext) {
    case '.md':   return 'text/markdown';
    case '.txt':  return 'text/plain';
    case '.json': return 'application/json';
    case '.csv':  return 'text/csv';
    case '.html':
    case '.htm':  return 'text/html';
    case '.pdf':  return 'application/pdf';
    case '.png':  return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif':  return 'image/gif';
    case '.webp': return 'image/webp';
    case '.svg':  return 'image/svg+xml';
    case '.mp4':  return 'video/mp4';
    case '.webm': return 'video/webm';
    case '.mp3':  return 'audio/mpeg';
    case '.ogg':  return 'audio/ogg';
    case '.wav':  return 'audio/wav';
    case '.zip':  return 'application/zip';
    default:      return 'application/octet-stream';
  }
}

function appendDeliverablesLog(workDir: string, entry: Record<string, unknown>): void {
  try {
    const logPath = path.join(workDir, '.run', 'deliverables.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(logPath, line, 'utf8');
  } catch {
    /* log 失败不影响主流程 */
  }
}

export interface IngestDeliverablesResult {
  assets: DeliverableAsset[];
  /** 详细的逐条结果（含 skip / fail 原因），仅供调用方决定文案 */
  records: Array<
    | { ok: true;  sourcePath: string; assetId: string }
    | { ok: false; sourcePath: string; reason: string }
  >;
}

/**
 * 将 `COMPLETE.deliverables: string[]` 吸收为 `DeliverableAsset[]`。
 *
 * @param workDir         内脑 workspace 根（用于解析相对路径 + 写 log）
 * @param relativePaths   `COMPLETE.deliverables` 字段（workspace 相对路径数组）
 * @param assetStore      Chat IR 资产仓库（任意 `ChatIRChannel` 共享同一实例）
 * @param opts.maxBytes   单文件字节上限，默认 `UTLRA_DELIVERABLE_MAX_BYTES` 或 25 MiB
 */
export function ingestDeliverables(
  workDir:       string,
  relativePaths: readonly string[],
  assetStore:    ChatAssetStore,
  opts: { maxBytes?: number } = {},
): IngestDeliverablesResult {
  const maxBytes =
    opts.maxBytes ??
    (Number(process.env['UTLRA_DELIVERABLE_MAX_BYTES']) || DEFAULT_MAX_BYTES);

  const result: IngestDeliverablesResult = { assets: [], records: [] };

  for (const rel of relativePaths) {
    const normalized = rel.trim();
    if (!normalized) continue;

    if (normalized.includes('..') || path.isAbsolute(normalized)) {
      const reason = `unsafe path (absolute or contains ..)`;
      result.records.push({ ok: false, sourcePath: normalized, reason });
      appendDeliverablesLog(workDir, { event: 'ingest_skip', path: normalized, reason });
      continue;
    }

    const absPath = path.join(workDir, normalized);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch (e) {
      const reason = `stat failed: ${e instanceof Error ? e.message : String(e)}`;
      result.records.push({ ok: false, sourcePath: normalized, reason });
      appendDeliverablesLog(workDir, { event: 'ingest_skip', path: normalized, reason });
      continue;
    }

    if (!stat.isFile()) {
      const reason = `not a regular file`;
      result.records.push({ ok: false, sourcePath: normalized, reason });
      appendDeliverablesLog(workDir, { event: 'ingest_skip', path: normalized, reason });
      continue;
    }

    if (stat.size > maxBytes) {
      const reason = `oversize ${stat.size} > ${maxBytes}`;
      result.records.push({ ok: false, sourcePath: normalized, reason });
      appendDeliverablesLog(workDir, { event: 'ingest_skip', path: normalized, reason });
      continue;
    }

    try {
      const buffer = fs.readFileSync(absPath);
      const mime   = inferMimeByPath(absPath);
      const filename = path.basename(normalized);
      const saved  = assetStore.save(buffer, mime, filename);

      const asset: DeliverableAsset = {
        asset_id:      saved.id,
        source_path:   normalized,
        filename:      saved.name,
        mime:          saved.mime,
        bytes:         saved.size,
        registered_at: saved.created_at,
        kind:          inferKindFromMime(saved.mime),
      };
      result.assets.push(asset);
      result.records.push({ ok: true, sourcePath: normalized, assetId: saved.id });
      appendDeliverablesLog(workDir, {
        event:      'ingest_ok',
        path:       normalized,
        asset_id:   saved.id,
        mime:       saved.mime,
        bytes:      saved.size,
      });
    } catch (e) {
      const reason = `read or save failed: ${e instanceof Error ? e.message : String(e)}`;
      result.records.push({ ok: false, sourcePath: normalized, reason });
      appendDeliverablesLog(workDir, { event: 'ingest_skip', path: normalized, reason });
    }
  }

  return result;
}

/**
 * `attach_asset_ids` → `MessagePart.attachment[]` 运行时展开器
 * （协议：`doc/protocols/inner-brain-deliverables.md` §6 / `doc/chat-ir-identity-design.md` §5.2.1）。
 *
 * 三个调用点：
 * 1. `reply_to_user` 工具（主对话流的语法糖）
 * 2. `send_file` 工具（独立附件工具）
 * 3. `orchestrator`：reply.v1 出站前展开 LLM 输出的 `attach_asset_ids`
 *
 * 协议规则要点：
 * - R6.4 / R6.5：当前阶段以 `assetStore.get(id)` 能否取到 meta 为最小合法性判定；
 *   无法解析的 id 静默剔除（warning 到 deliverables.log），**不阻断**整条回复。
 * - R6.6：`asset:<uuid>` 前缀容忍——自动 strip 后再校验。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ChatAssetStore } from '@utlra/chat-ir';
import { inferKindFromMime } from './deliverables-ingest.js';

/** 来自 `MessageRecord.parts` 的 attachment 子型；显式列出以避免引入完整 schema。 */
export interface AttachmentPart {
  type: 'attachment';
  asset_ref: {
    kind: 'image' | 'video' | 'audio' | 'file';
    uri:  string;
    mime: string;
    name: string;
  };
}

/** 去掉可选的 `asset:` 前缀，返回裸 UUID。 */
export function stripAssetPrefix(raw: string): string {
  const v = raw.trim();
  if (v.startsWith('asset:')) return v.slice('asset:'.length);
  return v;
}

export interface ExpandResult {
  parts: AttachmentPart[];
  /** 成功展开的 id（裸 UUID） */
  resolvedIds: string[];
  /** 被静默剔除的 id 与原因 */
  rejected: Array<{ id: string; reason: string }>;
}

/**
 * 给定 asset id 列表，展开为 attachment parts。
 *
 * @param ids        LLM 给出的 id 列表（可能带 `asset:` 前缀；可能含非法值）
 * @param assetStore Chat IR 资产仓库
 * @param opts.logDir 可选——若提供，把 rejected 写入 `<logDir>/deliverables.log`（与 ingest 同文件）
 */
export function expandAttachAssetIds(
  ids:        readonly string[] | undefined,
  assetStore: ChatAssetStore,
  opts: { logDir?: string } = {},
): ExpandResult {
  const result: ExpandResult = { parts: [], resolvedIds: [], rejected: [] };
  if (!ids || ids.length === 0) return result;

  for (const raw of ids) {
    const id = stripAssetPrefix(raw);
    if (!id) {
      result.rejected.push({ id: raw, reason: 'empty after strip' });
      continue;
    }

    const got = assetStore.get(id);
    if (!got) {
      result.rejected.push({ id, reason: 'asset not found in store' });
      continue;
    }

    result.parts.push({
      type: 'attachment',
      asset_ref: {
        kind: inferKindFromMime(got.meta.mime),
        uri:  `asset:${got.meta.id}`,
        mime: got.meta.mime,
        name: got.meta.name,
      },
    });
    result.resolvedIds.push(id);
  }

  if (opts.logDir && result.rejected.length > 0) {
    try {
      const logPath = path.join(opts.logDir, '.run', 'deliverables.log');
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      for (const r of result.rejected) {
        const line = JSON.stringify({
          ts:     new Date().toISOString(),
          event:  'attach_reject',
          id:     r.id,
          reason: r.reason,
        }) + '\n';
        fs.appendFileSync(logPath, line, 'utf8');
      }
    } catch {
      /* log 失败不影响主流程 */
    }
  }

  return result;
}

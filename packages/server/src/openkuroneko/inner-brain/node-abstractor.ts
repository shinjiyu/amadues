/**
 * Node Abstractor — LocalNode → NodeDef（脱敏 + LLM placeholder 推断 + auto-export）。
 *
 * ADL：doc/structurizr/INNER-NODE-LIFECYCLE.md §5 §7.1
 *
 * 触发：nodeCreatorExecutor 成功 commit_local_node 后 fire-and-forget。
 * 仅 origin=creator 且 metadata.export !== false 才导出。
 * 写 drive9 前做严格脱敏校验：sanitized 中不得残留任何具象 example/env 字面值。
 */

import type { LLMAdapter } from '../adapter/index.js';
import type { Logger } from '../logger/index.js';
import {
  computeDedupeKey,
  type NodeDefDrive9Store,
} from '../../drive9/node-def-drive9-store.js';
import type {
  LocalNode,
  NodeBody,
  NodeDef,
  NodeDefPlaceholder,
} from './types.js';

const MAX_PLACEHOLDERS = 16;
const PLACEHOLDER_NAME = /^[A-Z][A-Z0-9_]*$/;

export interface EnvSnapshot {
  workDir?: string;
  accountHints?: string[];
  hostHints?: string[];
}

export interface AbstractorDeps {
  llm: LLMAdapter;
  logger: Logger;
  store: NodeDefDrive9Store;
}

export interface AbstractorResult {
  ok: boolean;
  def?: NodeDef;
  /** 命中 dedupe（已存在等价 def，仅 bumpCite） */
  deduped?: boolean;
  reason?: string;
}

export const ABSTRACTOR_SYSTEM = `你是 NodeDef 抽象器。把一个具象 LocalNode 脱敏成可跨 agent 共享的 NodeDef 模板。

## 任务
- 找出 body 里所有「具象值」：绝对路径、账号、roomId、IP/host、token、随机 burst id 等
- 为每个具象值取一个 placeholder 名：UPPER_SNAKE（如 WORK_DIR / PS_ACCOUNT / BATTLE_ROOM）
- 输出 sanitizedBody：body 深拷贝，所有具象值替换成 \${{ NAME }}
- 输出 placeholders 清单

## 严格要求
- sanitizedBody 中**不得残留**任何真实路径/账号/host 字面值
- placeholder 数量 ≤ 16；过度抽象（把通用词也占位）会被拒绝
- 通用的、可复用的操作步骤文本应**保留**，不要占位

## 输出（只输出 JSON，不要解释）
{
  "defId": "语义名（无前缀，如 ps_open_battle）",
  "description": "一句话说明",
  "tags": ["..."],
  "sanitizedBody": { ...与输入 body 同结构，字符串含 \${{ NAME }} ... },
  "placeholders": [ { "name": "WORK_DIR", "kind": "path|account|room|secret|other", "required": true, "exampleHint": "可选" } ]
}`;

function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(trimmed); } catch { /* try to locate first {...} */ }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* ignore */ }
  }
  return null;
}

function extractPlaceholderNames(jsonStr: string): Set<string> {
  const names = new Set<string>();
  const re = /\$\{\{\s*([A-Z][A-Z0-9_]*)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(jsonStr)) !== null) names.add(m[1]!);
  return names;
}

/** 校验脱敏结果；返回 reason 表示失败 */
export function validateSanitized(
  sanitizedBody: NodeBody,
  placeholders: NodeDefPlaceholder[],
  env?: EnvSnapshot,
): { ok: boolean; reason?: string } {
  if (placeholders.length > MAX_PLACEHOLDERS) {
    return { ok: false, reason: `placeholder 数量 ${placeholders.length} 超过上限 ${MAX_PLACEHOLDERS}` };
  }
  for (const p of placeholders) {
    if (!PLACEHOLDER_NAME.test(p.name)) {
      return { ok: false, reason: `placeholder 名非法（需 UPPER_SNAKE）：${p.name}` };
    }
  }
  const json = JSON.stringify(sanitizedBody);
  const used = extractPlaceholderNames(json);
  for (const p of placeholders) {
    if (p.required && !used.has(p.name)) {
      return { ok: false, reason: `required placeholder ${p.name} 未在 sanitizedBody 中出现` };
    }
  }
  // 不得残留具象 env 字面值
  const leaks: string[] = [];
  for (const v of [env?.workDir, ...(env?.accountHints ?? []), ...(env?.hostHints ?? [])]) {
    if (v && v.length >= 3 && json.includes(v)) leaks.push(v);
  }
  if (leaks.length > 0) {
    return { ok: false, reason: `sanitizedBody 残留具象值：${leaks.join(', ')}` };
  }
  return { ok: true };
}

export async function abstractLocalNode(
  local: LocalNode,
  deps: AbstractorDeps,
  opts: { sourceAgent: string; env?: EnvSnapshot },
): Promise<AbstractorResult> {
  const { llm, logger, store } = deps;

  if (local.metadata.origin !== 'creator') {
    return { ok: false, reason: `origin=${local.metadata.origin} 不导出（仅 creator）` };
  }
  if (local.metadata.export === false) {
    return { ok: false, reason: 'metadata.export=false，跳过导出' };
  }

  const userMessage = [
    `## 源 LocalNode`,
    '```json',
    JSON.stringify({ id: local.id, description: local.description, tags: local.tags, interface: local.interface, body: local.body }, null, 2),
    '```',
    opts.env ? `## 环境快照（这些具象值必须被占位）\n${JSON.stringify(opts.env, null, 2)}` : '',
    `输出脱敏后的 NodeDef JSON。`,
  ].filter(Boolean).join('\n\n');

  let parsed: unknown;
  try {
    const result = await llm.chat(ABSTRACTOR_SYSTEM, [{ role: 'user', content: userMessage }]);
    parsed = parseJsonLoose(result.content ?? '');
  } catch (e) {
    logger.warn('node-abstractor', { event: 'llm.error', data: { localId: local.id, error: String(e) } });
    return { ok: false, reason: `Abstractor LLM 失败：${String(e)}` };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'Abstractor LLM 输出无法解析为 JSON' };
  }
  const o = parsed as Record<string, unknown>;
  const defId = String(o['defId'] ?? '').trim().replace(/[^a-z0-9_]/gi, '_');
  const sanitizedBody = o['sanitizedBody'] as NodeBody | undefined;
  const placeholders = Array.isArray(o['placeholders']) ? (o['placeholders'] as NodeDefPlaceholder[]) : [];

  if (!defId) return { ok: false, reason: 'Abstractor 输出缺少 defId' };
  if (!sanitizedBody || !sanitizedBody.kind) return { ok: false, reason: 'Abstractor 输出缺少 sanitizedBody' };

  const validation = validateSanitized(sanitizedBody, placeholders, opts.env);
  if (!validation.ok) {
    logger.warn('node-abstractor', { event: 'sanitize.reject', data: { localId: local.id, reason: validation.reason } });
    return { ok: false, reason: validation.reason };
  }

  const dedupeKey = computeDedupeKey(sanitizedBody, local.interface);
  const existing = await store.findByDedupeKey(dedupeKey);
  if (existing) {
    await store.bumpCite(existing.id, existing.version);
    logger.info('node-abstractor', { event: 'dedupe.hit', data: { localId: local.id, defId: existing.id } });
    const def = await store.get(existing.id, existing.version);
    return { ok: true, deduped: true, ...(def ? { def } : {}) };
  }

  const now = new Date().toISOString();
  const def: NodeDef = {
    id: defId,
    version: '1.0.0',
    description: String(o['description'] ?? local.description),
    tags: Array.isArray(o['tags']) ? (o['tags'] as unknown[]).map(String) : local.tags,
    placeholders,
    interface: local.interface,
    body: sanitizedBody,
    metadata: {
      sourceAgent: opts.sourceAgent,
      sourceLocalId: local.id,
      dedupeKey,
      citeCount: 0,
      importCount: 0,
      assembleFailCount: 0,
      createdAt: now,
      status: 'active',
    },
  };

  await store.put(def);
  logger.info('node-abstractor', { event: 'exported', data: { localId: local.id, defId: def.id } });
  return { ok: true, def };
}

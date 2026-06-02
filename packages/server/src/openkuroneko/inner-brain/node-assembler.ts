/**
 * Node Assembler — NodeDef + binding → imported LocalNode。
 *
 * ADL：doc/structurizr/INNER-NODE-LIFECYCLE.md §6
 *
 * LLM 推断 placeholder → 具象值 binding；机械替换 ${{ NAME }} 后校验无残留，
 * 生成 origin=imported 的 LocalNode 写入 localNodeStore，并 bumpImport。
 * 失败（缺 required / 残留占位）→ bumpAssembleFail，跳过。
 * 幂等：imported/<defId>@<ver> 已存在则直接返回。
 */

import type { LLMAdapter } from '../adapter/index.js';
import type { Logger } from '../logger/index.js';
import type { NodeDefDrive9Store } from '../../drive9/node-def-drive9-store.js';
import type { LocalNodeStore } from './local-node-store.js';
import type { EnvSnapshot } from './node-abstractor.js';
import type { LocalNode, NodeDef } from './types.js';

const RESIDUAL = /\$\{\{\s*[A-Z][A-Z0-9_]*\s*\}\}/;
const RATIONALE_MAX = 1024;

export interface AssemblerDeps {
  llm: LLMAdapter;
  logger: Logger;
  defStore: NodeDefDrive9Store;
  localStore: LocalNodeStore;
}

export interface AssembleResult {
  ok: boolean;
  localId?: string;
  reason?: string;
  /** 幂等命中（已装配过） */
  skipped?: boolean;
}

export const ASSEMBLER_SYSTEM = `你是 NodeDef 装配器。把一个共享 NodeDef 模板绑定到当前环境，补全所有 placeholder 的具象值。

## 任务
- 读 def.placeholders 与环境快照
- 为每个 placeholder 给出当前环境下的具象值（所有 required 必须补全）
- 给一段简短「装配理由」说明这些值怎么来的

## 输出（只输出 JSON）
{
  "binding": { "WORK_DIR": "/home/gin/work", "PS_ACCOUNT": "gin_bot" },
  "rationale": "一句话"
}`;

function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(trimmed); } catch { /* locate braces */ }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* ignore */ }
  }
  return null;
}

/** 在任意 JSON 结构里把 ${{ NAME }} 替换成 binding 值（保持 JSON 合法） */
export function applyBinding<T>(value: T, binding: Record<string, string>): T {
  let json = JSON.stringify(value);
  for (const [name, val] of Object.entries(binding)) {
    const re = new RegExp(`\\$\\{\\{\\s*${name}\\s*\\}\\}`, 'g');
    const escaped = JSON.stringify(String(val)).slice(1, -1);
    json = json.replace(re, escaped);
  }
  return JSON.parse(json) as T;
}

export function importedId(def: NodeDef): string {
  return `imported/${def.id}@${def.version}`;
}

export async function assembleNodeDef(
  def: NodeDef,
  workDir: string,
  deps: AssemblerDeps,
  opts?: { env?: EnvSnapshot; bindingHints?: Record<string, string> },
): Promise<AssembleResult> {
  const { llm, logger, defStore, localStore } = deps;
  const localId = importedId(def);

  if (localStore.has(localId)) {
    return { ok: true, localId, skipped: true };
  }

  let parsed: unknown;
  try {
    const userMessage = [
      `## NodeDef placeholders`,
      '```json',
      JSON.stringify(def.placeholders, null, 2),
      '```',
      `## 当前 workDir\n${workDir}`,
      opts?.env ? `## 环境快照\n${JSON.stringify(opts.env, null, 2)}` : '',
      opts?.bindingHints ? `## 绑定线索\n${JSON.stringify(opts.bindingHints, null, 2)}` : '',
      `输出 binding JSON。`,
    ].filter(Boolean).join('\n\n');
    const result = await llm.chat(ASSEMBLER_SYSTEM, [{ role: 'user', content: userMessage }]);
    parsed = parseJsonLoose(result.content ?? '');
  } catch (e) {
    await defStore.bumpAssembleFail(def.id, def.version);
    return { ok: false, reason: `Assembler LLM 失败：${String(e)}` };
  }

  const binding =
    parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>)['binding']
      ? ((parsed as Record<string, unknown>)['binding'] as Record<string, string>)
      : {};
  const rationale = String((parsed as Record<string, unknown>)?.['rationale'] ?? '').slice(0, RATIONALE_MAX);

  // 补 bindingHints 兜底
  const merged: Record<string, string> = { ...(opts?.bindingHints ?? {}), ...binding };

  const missing = def.placeholders.filter(p => p.required && !merged[p.name]).map(p => p.name);
  if (missing.length > 0) {
    await defStore.bumpAssembleFail(def.id, def.version);
    logger.warn('node-assembler', { event: 'binding.missing', data: { defId: def.id, missing } });
    return { ok: false, reason: `binding 缺少 required placeholder：${missing.join(', ')}` };
  }

  const body = applyBinding(def.body, merged);
  const iface = applyBinding(def.interface, merged);
  if (RESIDUAL.test(JSON.stringify(body)) || RESIDUAL.test(JSON.stringify(iface))) {
    await defStore.bumpAssembleFail(def.id, def.version);
    logger.warn('node-assembler', { event: 'binding.residual', data: { defId: def.id } });
    return { ok: false, reason: '替换后仍残留 ${{...}} 占位' };
  }

  const now = new Date().toISOString();
  const local: LocalNode = {
    id: localId,
    version: def.version,
    displayName: def.id,
    description: def.description,
    tags: def.tags,
    interface: iface,
    body,
    metadata: {
      origin: 'imported',
      sourceDef: `${def.id}@${def.version}`,
      export: false,
      workDir,
      ...(rationale ? { provenance: { bindingRationale: rationale } } : {}),
      createdAt: now,
      updatedAt: now,
    },
  };

  try {
    localStore.commit(local);
  } catch (e) {
    await defStore.bumpAssembleFail(def.id, def.version);
    return { ok: false, reason: `commit imported LocalNode 失败：${String(e)}` };
  }

  await defStore.bumpImport(def.id, def.version);
  logger.info('node-assembler', { event: 'assembled', data: { defId: def.id, localId } });
  return { ok: true, localId };
}

/**
 * EW execute：从 keychain 解析 secretRefs。
 * @see doc/structurizr/EXECUTABLE-WORKFLOW.md W11 · MEMORY-BLOCKS.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { MemoryBlockStore } from '../outer/memory-block-store.js';
import type { WorkflowStep } from '../outer/executable-workflow-types.js';

export type ResolveSecretFn = (keychainKey: string) => Promise<string | null>;

export function createKeychainResolveSecret(opts: {
  dataRoot: string;
  agentId?: string;
}): ResolveSecretFn {
  const store = new MemoryBlockStore({
    dataRoot: opts.dataRoot,
    agentId:
      opts.agentId?.trim() ||
      process.env['UTLRA_AGENT_NAME']?.trim() ||
      process.env['UTLRA_AGENT_IM_SID']?.trim() ||
      'default',
  });
  return async (keychainKey: string) => {
    const meta = await store.get('keychain', keychainKey.trim(), { includeValue: true });
    if (!meta) return null;
    const v = meta['value'];
    if (typeof v === 'string') return v;
    if (v != null) return JSON.stringify(v);
    return null;
  };
}

export interface ResolvedStepSecrets {
  /** shell 环境变量 */
  env: Record<string, string>;
  /** 若有 COOKIES / COOKIE 类，相对 workDir 的 cookies 文件 */
  cookiesFileRel?: string;
}

/**
 * 解析 step.secretRefs；COOKIES/COOKIE 额外物化为 `.run/ew/secrets/{stepId}-cookies.json`。
 */
export async function resolveStepSecrets(
  step: WorkflowStep,
  workDir: string,
  resolveSecret: ResolveSecretFn,
): Promise<ResolvedStepSecrets> {
  const refs = step.secretRefs;
  if (!refs || Object.keys(refs).length === 0) return { env: {} };

  const env: Record<string, string> = {};
  let cookiesRaw: string | undefined;

  for (const [envName, keychainKey] of Object.entries(refs)) {
    const name = envName.trim();
    const key = String(keychainKey ?? '').trim();
    if (!name || !key) continue;
    const value = await resolveSecret(key);
    if (value == null || value === '') {
      throw new Error(`secretRefs: keychain "${key}" 无值或不存在（step ${step.id}）`);
    }
    env[name] = value;
    if (/^COOKIES?$/i.test(name) || /^X_?COOKIES?$/i.test(name)) {
      cookiesRaw = value;
    }
  }

  let cookiesFileRel: string | undefined;
  if (cookiesRaw) {
    const rel = path.join('.run', 'ew', 'secrets', `${step.id}-cookies.json`);
    const abs = path.resolve(workDir, rel);
    if (!abs.startsWith(path.resolve(workDir))) {
      throw new Error('cookies path escapes workDir');
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    // 支持：原始 Cookie 头字符串，或已是 JSON
    const trimmed = cookiesRaw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      fs.writeFileSync(abs, trimmed, 'utf8');
    } else {
      fs.writeFileSync(abs, JSON.stringify({ cookie: trimmed }, null, 2), 'utf8');
    }
    cookiesFileRel = rel.replace(/\\/g, '/');
  }

  return { env, cookiesFileRel };
}

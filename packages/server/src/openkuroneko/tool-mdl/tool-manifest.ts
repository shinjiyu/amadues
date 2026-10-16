/**
 * toolManifest — 工具接口契约（ADL: TOOL-MDL-GROWTH.md M7 / M9）
 *
 * description 的 token 上限在接口层强制：它是工具的文法代价，**每一轮都付**。
 * kind='acquisition' 默认禁止：那类工具扩张 A_prim，不是压缩，须显式开闸并单独记账。
 */
import { countTokens } from './action-log.js';

export type ToolArgType = 'string' | 'number' | 'boolean';

export interface ToolManifest {
  name: string;
  description: string;
  args: Record<string, { type: ToolArgType; required?: boolean }>;
  deps: string[];
  kind: 'composition' | 'acquisition';
  createdAt: string;
  minedFrom?: {
    symbols: string[];
    support: number;
    /**
     * 收录时估出的每次节省。退役时若工具仍被调用，必须用这个数——
     * 采用后语料里的原始片段已被折叠，再从 minedFrom.symbols 回算会得到 0，
     * 于是刚成功的工具被误杀（§11.15）。
     */
    savedTokensPerUse?: number;
  };
}

export interface ManifestValidateOptions {
  descriptionTokenBudget?: number;
  allowAcquisition?: boolean;
}

export const DEFAULT_DESCRIPTION_TOKEN_BUDGET = 32;

const NAME_RE = /^[a-z][a-z0-9_]*$/;
const ARG_TYPES: ToolArgType[] = ['string', 'number', 'boolean'];

export function validateToolManifest(m: unknown, opts: ManifestValidateOptions = {}): string[] {
  const budget = opts.descriptionTokenBudget ?? DEFAULT_DESCRIPTION_TOKEN_BUDGET;
  const errs: string[] = [];
  if (typeof m !== 'object' || m === null) return ['manifest must be an object'];
  const t = m as Record<string, unknown>;

  if (typeof t.name !== 'string' || !NAME_RE.test(t.name)) {
    errs.push('name must be snake_case matching /^[a-z][a-z0-9_]*$/');
  }

  if (typeof t.description !== 'string' || t.description.trim().length === 0) {
    errs.push('description must be a non-empty string');
  } else if (countTokens(t.description) > budget) {
    errs.push(`description exceeds ${budget} tokens (M7: grammar cost is paid every turn)`);
  }

  if (typeof t.args !== 'object' || t.args === null || Array.isArray(t.args)) {
    errs.push('args must be an object');
  } else {
    for (const [key, spec] of Object.entries(t.args as Record<string, unknown>)) {
      const s = spec as { type?: unknown };
      if (!s || !ARG_TYPES.includes(s.type as ToolArgType)) {
        errs.push(`args.${key}.type must be one of ${ARG_TYPES.join('|')}`);
      }
    }
  }

  if (!Array.isArray(t.deps) || t.deps.some(d => typeof d !== 'string')) {
    errs.push('deps must be an array of tool names');
  } else if (typeof t.name === 'string' && (t.deps as string[]).includes(t.name)) {
    errs.push('deps must not contain the tool itself');
  }

  if (t.kind !== 'composition' && t.kind !== 'acquisition') {
    errs.push("kind must be 'composition' or 'acquisition'");
  } else if (t.kind === 'acquisition' && !opts.allowAcquisition) {
    errs.push('kind=acquisition is disabled by default (M9: extends A_prim, must be gated and accounted separately)');
  }

  if (typeof t.createdAt !== 'string' || t.createdAt.length === 0) {
    errs.push('createdAt must be an ISO timestamp');
  }

  return errs;
}

export function parseToolManifest(json: string, opts: ManifestValidateOptions = {}): ToolManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  return validateToolManifest(raw, opts).length === 0 ? (raw as ToolManifest) : null;
}

/** 文法代价：索引里这一条占多少 token */
export function manifestCostTokens(m: ToolManifest): number {
  const argNames = Object.keys(m.args ?? {}).join(', ');
  return countTokens(`${m.name}(${argNames}): ${m.description}`);
}

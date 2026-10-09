/**
 * 宪章（constitution.md）加载器 — ADL doc/structurizr/AGENT-SUBJECT-DESIGN.md §3
 *
 * 宪章定义 subject 模式 agent 的身份、驱动力、长期目标与放弃条款，地位高于 soul.md。
 * 路径：DATA_ROOT/outer/constitution.md；每次调用重新读取（热更新）。
 *
 * 机器可读部分：`## 长期目标` 小节下的列表行，格式
 *   - [slug] 目标描述
 *   - [slug|delivery] 目标描述        （缺省 kind=ongoing）
 * `## 放弃条款` 小节全文作为 abandonmentClause。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { KpiKind } from './kpi-registry.js';

export interface ConstitutionGoal {
  slug: string;
  objective: string;
  kind: KpiKind;
}

export interface Constitution {
  raw: string;
  goals: ConstitutionGoal[];
  abandonmentClause: string;
}

const CONSTITUTION_FILENAME = 'constitution.md';
const GOAL_LINE_RE = /^\s*[-*]\s*\[([a-z0-9][a-z0-9_-]*)(?:\|(ongoing|delivery))?\]\s*(.+?)\s*$/i;

function sectionBody(raw: string, heading: string): string {
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+/.test(l) && l.replace(/^##\s+/, '').trim() === heading);
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s+/.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
}

export function parseConstitution(raw: string): Constitution {
  const goals: ConstitutionGoal[] = [];
  const seen = new Set<string>();
  for (const line of sectionBody(raw, '长期目标').split(/\r?\n/)) {
    const m = GOAL_LINE_RE.exec(line);
    if (!m) continue;
    const slug = m[1]!.toLowerCase();
    if (seen.has(slug)) continue;
    seen.add(slug);
    goals.push({
      slug,
      objective: m[3]!,
      kind: m[2]?.toLowerCase() === 'delivery' ? 'delivery' : 'ongoing',
    });
  }
  return { raw, goals, abandonmentClause: sectionBody(raw, '放弃条款') };
}

/** 读取 DATA_ROOT/outer/constitution.md；不存在或为空时返回 null（subject 模式无宪章即不播种）。 */
export function loadConstitution(dataRoot: string): Constitution | null {
  try {
    const raw = fs.readFileSync(path.join(dataRoot, 'outer', CONSTITUTION_FILENAME), 'utf8').trim();
    return raw ? parseConstitution(raw) : null;
  } catch {
    return null;
  }
}

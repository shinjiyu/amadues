/**
 * Node Skill Loader — baseNode 执行前加载节点绑定技能 + 可选全局检索。
 *
 * ADL：doc/structurizr/INNER-NODE-SKILLS.md §5 · HARNESS-RSI.md P2（优先 active H skillRefs）
 */

import type { SkillProvider } from '../skills/provider.js';
import type { LocalNode, NodeInst, NodeSkillRef } from './types.js';
import { createNodeSkillStore } from './node-skill-store.js';
import { createHarnessPointer } from './harness-pointer.js';
import { createHarnessSpecStore } from './harness-spec-store.js';

const CONTENT_MAX = 3000;
const DEFAULT_GLOBAL_TOP_K = 3;

export interface LoadNodeSkillsOpts {
  node: LocalNode;
  inst: NodeInst;
  workDir: string;
  skillProvider?: SkillProvider;
  globalTopK?: number;
}

export interface LoadedNodeSkills {
  refs: NodeSkillRef[];
  section: string;
}

/** Prefer skill ids bound on active HarnessSpec for this node (P2). */
export function preferredSkillIdsFromActiveHarness(workDir: string, nodeRef: string): string[] {
  try {
    const store = createHarnessSpecStore(workDir);
    const active = createHarnessPointer(workDir, store).readActive();
    if (!active) return [];
    const spec = store.get(active.harnessId);
    if (!spec?.refs.skillRefs?.length) return [];
    return spec.refs.skillRefs
      .filter((s) => s.nodeRef === nodeRef)
      .map((s) => s.skillId);
  } catch {
    return [];
  }
}

export async function loadNodeSkills(opts: LoadNodeSkillsOpts): Promise<LoadedNodeSkills> {
  const { node, inst, workDir, skillProvider, globalTopK = DEFAULT_GLOBAL_TOP_K } = opts;
  const store = createNodeSkillStore(workDir);
  const seen = new Set<string>();
  const parts: string[] = [];
  const refs: NodeSkillRef[] = [];

  const addSkill = (
    ref: NodeSkillRef,
    content: string,
    source: 'bound' | 'harness' | 'global',
  ): void => {
    if (seen.has(ref.id)) return;
    seen.add(ref.id);
    refs.push(ref);
    const truncated =
      content.length > CONTENT_MAX ? content.slice(0, CONTENT_MAX) + '\n…（内容已截断）' : content;
    parts.push(
      `### ${ref.title} (id: ${ref.id}, category: ${ref.category}, source: ${source})\n${truncated}`,
    );
  };

  const index = store.readIndex(node.id);
  const byId = new Map(index.map((r) => [r.id, r]));

  for (const skillId of preferredSkillIdsFromActiveHarness(workDir, node.id)) {
    const ref = byId.get(skillId);
    if (!ref) continue;
    const content = store.readContent(node.id, ref.id);
    if (content) addSkill(ref, content, 'harness');
  }

  const boundRefs = node.skills?.length ? node.skills : index;
  for (const ref of boundRefs) {
    const content = store.readContent(node.id, ref.id);
    if (content) addSkill(ref, content, 'bound');
  }

  if (skillProvider) {
    const query = [node.description, ...(node.tags ?? []), inst.instruction ?? '']
      .filter(Boolean)
      .join(' ')
      .trim();
    if (query) {
      const global = await Promise.resolve(skillProvider.search(query, globalTopK));
      for (const e of global) {
        const content = skillProvider.getContent(e);
        if (!content) continue;
        addSkill(
          { id: e.id, category: e.category, title: e.title, tags: e.tags },
          content,
          'global',
        );
      }
    }
  }

  if (parts.length === 0) {
    return { refs: [], section: '' };
  }

  const section = ['## 节点技能（执行前加载）', ...parts].join('\n\n');
  return { refs, section };
}

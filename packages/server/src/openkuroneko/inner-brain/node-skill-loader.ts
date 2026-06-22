/**
 * Node Skill Loader — baseNode 执行前加载节点绑定技能 + 可选全局检索。
 *
 * ADL：doc/structurizr/INNER-NODE-SKILLS.md §5
 */

import type { SkillProvider } from '../skills/provider.js';
import type { LocalNode, NodeInst, NodeSkillRef } from './types.js';
import { createNodeSkillStore } from './node-skill-store.js';

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

export async function loadNodeSkills(opts: LoadNodeSkillsOpts): Promise<LoadedNodeSkills> {
  const { node, inst, workDir, skillProvider, globalTopK = DEFAULT_GLOBAL_TOP_K } = opts;
  const store = createNodeSkillStore(workDir);
  const seen = new Set<string>();
  const parts: string[] = [];
  const refs: NodeSkillRef[] = [];

  const addSkill = (ref: NodeSkillRef, content: string, source: 'bound' | 'global'): void => {
    if (seen.has(ref.id)) return;
    seen.add(ref.id);
    refs.push(ref);
    const truncated =
      content.length > CONTENT_MAX ? content.slice(0, CONTENT_MAX) + '\n…（内容已截断）' : content;
    parts.push(
      `### ${ref.title} (id: ${ref.id}, category: ${ref.category}, source: ${source})\n${truncated}`,
    );
  };

  const boundRefs = node.skills?.length ? node.skills : store.readIndex(node.id);
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

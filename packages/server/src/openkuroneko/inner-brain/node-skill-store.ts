/**
 * Node Skill Store — 节点绑定技能读写（.brain/local_nodes/skills/）
 *
 * ADL：doc/structurizr/INNER-NODE-SKILLS.md §2
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { LocalNodeStore } from './local-node-store.js';
import type { NodeDefSkill, NodeSkillRef } from './types.js';

const INDEX_HEADER = '# node skills index: id\tcategory\ttitle\ttags\tts\n';
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

export function encodeNodeIdForSkills(nodeRef: string): string {
  return nodeRef.replace(/\//g, '__');
}

function skillsRoot(workDir: string): string {
  return path.join(workDir, '.brain', 'local_nodes', 'skills');
}

function nodeSkillsDir(workDir: string, nodeRef: string): string {
  return path.join(skillsRoot(workDir), encodeNodeIdForSkills(nodeRef));
}

function indexPath(workDir: string, nodeRef: string): string {
  return path.join(nodeSkillsDir(workDir, nodeRef), 'skills.md');
}

function skillFilePath(workDir: string, nodeRef: string, category: string, id: string): string {
  const safeCat = category.replace(/[^a-z0-9_-]/gi, '_').toLowerCase() || 'general';
  return path.join(nodeSkillsDir(workDir, nodeRef), safeCat, `${id}.md`);
}

function parseIndex(raw: string): NodeSkillRef[] {
  if (!raw.trim()) return [];
  return raw
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('//'))
    .map(l => {
      const [id, category, title, tagsStr] = l.split('\t');
      if (!id || !category || !title) return null;
      const tags = (tagsStr ?? '').split(',').map(t => t.trim()).filter(Boolean);
      return {
        id: id.trim(),
        category: category.trim(),
        title: title.trim(),
        ...(tags.length > 0 ? { tags } : {}),
      } as NodeSkillRef;
    })
    .filter((e): e is NodeSkillRef => e !== null);
}

function newSkillId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5\s-]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .join('-')
    .replace(/[\u4e00-\u9fa5]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
  const suffix = crypto.randomBytes(2).toString('hex');
  return slug ? `${slug}-${suffix}` : `skill-${suffix}`;
}

export interface WriteNodeSkillParams {
  category: string;
  title: string;
  tags?: string[];
  content: string;
  /** 导入时保留原 id（NodeDef 装配） */
  id?: string;
}

export interface WriteNodeSkillResult {
  id: string;
  action: 'created' | 'merged';
  ref: NodeSkillRef;
}

export interface NodeSkillStore {
  readIndex(nodeRef: string): NodeSkillRef[];
  readContent(nodeRef: string, skillId: string): string | null;
  writeSkill(nodeRef: string, params: WriteNodeSkillParams): WriteNodeSkillResult;
  copySkills(fromNodeRef: string, toNodeRef: string): NodeSkillRef[];
  importSkills(nodeRef: string, skills: NodeDefSkill[]): NodeSkillRef[];
  exportSkills(nodeRef: string): NodeDefSkill[];
  attachToLocalNode(localStore: LocalNodeStore, nodeRef: string, ref: NodeSkillRef): void;
}

export function createNodeSkillStore(workDir: string): NodeSkillStore {
  function readIndex(nodeRef: string): NodeSkillRef[] {
    try {
      return parseIndex(fs.readFileSync(indexPath(workDir, nodeRef), 'utf8'));
    } catch {
      return [];
    }
  }

  function writeIndex(nodeRef: string, entries: NodeSkillRef[]): void {
    const dir = nodeSkillsDir(workDir, nodeRef);
    fs.mkdirSync(dir, { recursive: true });
    const lines = [INDEX_HEADER];
    for (const e of entries) {
      lines.push([e.id, e.category, e.title, (e.tags ?? []).join(','), ''].join('\t') + '\n');
    }
    fs.writeFileSync(indexPath(workDir, nodeRef), lines.join(''), 'utf8');
  }

  function readContent(nodeRef: string, skillId: string): string | null {
    const entry = readIndex(nodeRef).find(e => e.id === skillId);
    if (!entry) return null;
    try {
      return fs.readFileSync(skillFilePath(workDir, nodeRef, entry.category, entry.id), 'utf8').trim();
    } catch {
      return null;
    }
  }

  function writeSkill(nodeRef: string, params: WriteNodeSkillParams): WriteNodeSkillResult {
    const category = params.category.replace(/[^a-z0-9_-]/gi, '_').toLowerCase() || 'general';
    const title = params.title.trim();
    const content = params.content.trim();
    if (!title || !content) {
      throw new Error('[node-skill-store] title and content required');
    }

    const entries = readIndex(nodeRef);
    const tags = params.tags ?? [];
    const ts = new Date().toISOString();

    if (params.id?.trim()) {
      const id = params.id.trim();
      const fp = skillFilePath(workDir, nodeRef, category, id);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(
        fp,
        `# ${title}\n\n> category: ${category} | id: ${id} | ${ts}\n\n${content}\n`,
        'utf8',
      );
      const ref: NodeSkillRef = { id, category, title, ...(tags.length > 0 ? { tags } : {}) };
      const without = entries.filter(e => e.id !== id);
      writeIndex(nodeRef, [...without, ref]);
      return { id, action: 'created', ref };
    }

    const existing = entries.find(e => e.title === title && e.category === category);
    if (existing) {
      const fp = skillFilePath(workDir, nodeRef, existing.category, existing.id);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.appendFileSync(fp, `\n\n---\n> 更新 ${ts}\n\n${content}\n`, 'utf8');
      const mergedTags = [...new Set([...(existing.tags ?? []), ...tags])];
      const updated: NodeSkillRef = { ...existing, tags: mergedTags };
      writeIndex(nodeRef, entries.map(e => (e.id === existing.id ? updated : e)));
      return { id: existing.id, action: 'merged', ref: updated };
    }

    const id = newSkillId(title);
    if (!ID_PATTERN.test(id.replace(/-/g, '_'))) {
      throw new Error(`[node-skill-store] invalid skill id: ${id}`);
    }
    const fp = skillFilePath(workDir, nodeRef, category, id);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(
      fp,
      `# ${title}\n\n> category: ${category} | id: ${id} | ${ts}\n\n${content}\n`,
      'utf8',
    );
    const ref: NodeSkillRef = { id, category, title, ...(tags.length > 0 ? { tags } : {}) };
    writeIndex(nodeRef, [...entries, ref]);
    return { id, action: 'created', ref };
  }

  function copyFileSkills(fromNodeRef: string, toNodeRef: string): NodeSkillRef[] {
    const srcDir = nodeSkillsDir(workDir, fromNodeRef);
    const destDir = nodeSkillsDir(workDir, toNodeRef);
    if (!fs.existsSync(srcDir)) return [];

    fs.mkdirSync(destDir, { recursive: true });
    const copyRecursive = (src: string, dest: string): void => {
      for (const name of fs.readdirSync(src)) {
        const s = path.join(src, name);
        const d = path.join(dest, name);
        const stat = fs.statSync(s);
        if (stat.isDirectory()) {
          fs.mkdirSync(d, { recursive: true });
          copyRecursive(s, d);
        } else {
          fs.copyFileSync(s, d);
        }
      }
    };
    copyRecursive(srcDir, destDir);
    return readIndex(toNodeRef);
  }

  return {
    readIndex,
    readContent,
    writeSkill,
    copySkills: copyFileSkills,
    importSkills(nodeRef: string, skills: NodeDefSkill[]): NodeSkillRef[] {
      const refs: NodeSkillRef[] = [];
      for (const s of skills) {
        const r = writeSkill(nodeRef, {
          id: s.id,
          category: s.category,
          title: s.title,
          tags: s.tags,
          content: s.content,
        });
        refs.push(r.ref);
      }
      return refs;
    },
    exportSkills(nodeRef: string): NodeDefSkill[] {
      return readIndex(nodeRef).map(ref => ({
        ...ref,
        content: readContent(nodeRef, ref.id) ?? '',
      })).filter(s => s.content.length > 0);
    },
    attachToLocalNode(localStore: LocalNodeStore, nodeRef: string, ref: NodeSkillRef): void {
      const node = localStore.read(nodeRef);
      if (!node) return;
      const skills = node.skills ?? [];
      if (skills.some(s => s.id === ref.id)) return;
      localStore.commit({ ...node, skills: [...skills, ref] });
    },
  };
}

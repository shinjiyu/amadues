/**
 * Lightweight Structurizr DSL parser for diff (subset of workspace.dsl syntax).
 */
import fs from 'node:fs';
import path from 'node:path';

const INCLUDE_RE = /^\s*!include\s+(.+?)\s*$/;

/** Inline `!include` files so diff sees L3 from components/*.dsl */
export function preprocessIncludes(text, baseDir) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(INCLUDE_RE);
    if (m) {
      const incPath = path.resolve(baseDir, m[1].trim());
      const incText = fs.readFileSync(incPath, 'utf8');
      out.push(preprocessIncludes(incText, path.dirname(incPath)));
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

const EL_RE = /^\s*(\w+)\s*=\s*(person|softwareSystem|container|component)\s+"([^"]*)"/;
const REL_RE = /^\s*([\w.]+)\s*->\s*([\w.]+)\s+"([^"]*)"(?:\s+"([^"]*)")?/;

export function parseWorkspaceDsl(text) {
  const elements = new Map();
  const relationships = [];
  const stack = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;

    const em = line.match(EL_RE);
    if (em) {
      const [, id, type, name] = em;
      const parent = stack.length ? stack[stack.length - 1] : null;
      const qualified = parent ? `${parent}.${id}` : id;
      elements.set(qualified, { id, qualified, type, name, parent });
      if (type === 'softwareSystem' || type === 'container') {
        stack.push(qualified);
      }
      continue;
    }

    if (trimmed === '}') {
      stack.pop();
      continue;
    }

    const rm = line.match(REL_RE);
    if (rm) {
      const [, src, dst, desc, tech] = rm;
      const tags = [];
      const tagBlock = /tags\s+"([^"]+)"/.exec(line);
      if (tagBlock) tags.push(...tagBlock[1].split(/[, ]+/).filter(Boolean));
      relationships.push({
        key: `${src}->${dst}|${desc}`,
        src,
        dst,
        description: desc,
        technology: tech ?? '',
        tags,
      });
    }
  }

  return { elements, relationships };
}

export function loadWorkspace(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const text = preprocessIncludes(raw, path.dirname(path.resolve(filePath)));
  return { path: filePath, ...parseWorkspaceDsl(text) };
}

export function diffWorkspaces(left, right) {
  const elementLeft = new Set(left.elements.keys());
  const elementRight = new Set(right.elements.keys());
  const addedElements = [...elementRight].filter((k) => !elementLeft.has(k));
  const removedElements = [...elementLeft].filter((k) => !elementRight.has(k));

  const relLeft = new Map(left.relationships.map((r) => [r.key, r]));
  const relRight = new Map(right.relationships.map((r) => [r.key, r]));
  const addedRel = right.relationships.filter((r) => !relLeft.has(r.key));
  const removedRel = left.relationships.filter((r) => !relRight.has(r.key));

  const changedName = [];
  for (const k of elementLeft) {
    if (!elementRight.has(k)) continue;
    const a = left.elements.get(k);
    const b = right.elements.get(k);
    if (a.type !== b.type || a.name !== b.name) {
      changedName.push({ qualified: k, left: a, right: b });
    }
  }

  return {
    addedElements: addedElements.map((k) => right.elements.get(k)),
    removedElements: removedElements.map((k) => left.elements.get(k)),
    changedElements: changedName,
    addedRelationships: addedRel,
    removedRelationships: removedRel,
  };
}

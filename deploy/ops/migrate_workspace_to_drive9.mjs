#!/usr/bin/env node
/**
 * Export remaining workspace facts/skills into self-hosted Drive9.
 * Usage:
 *   node deploy/ops/migrate_workspace_to_drive9.mjs [--dry-run] [--facts-only] [--skills-only]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const SERVER = path.join(REPO, 'packages/server');

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const FACTS_ONLY = args.has('--facts-only');
const SKILLS_ONLY = args.has('--skills-only');

const apiKey = (
  process.env.DRIVE9_API_KEY ||
  fs.readFileSync(path.join(REPO, '.local/drive9-api.key'), 'utf8')
).trim();
const apiUrl = (process.env.DRIVE9_SERVER || 'http://127.0.0.1:9009').replace(/\/$/, '');
const base = `${apiUrl}/v1/fs`;

const DATA_ROOTS = [
  ['kuroneko', 'data'],
  ['gin', 'data-gin'],
  ['aoi', 'data-aoi'],
  ['shiro', 'data-shiro'],
  ['yuanbao', 'data-yuanbao'],
  ['bot1', 'data-bot1'],
  ['bot2', 'data-bot2'],
  ['bot3', 'data-bot3'],
];

const MAX_FACT_CHARS = 2000;
const SECRET_REDACT = [
  { pattern: /\bsk-[a-zA-Z0-9_-]{12,}\b/gi, replacement: 'sk-<redacted>' },
  { pattern: /\bghp_[a-zA-Z0-9]{20,}\b/gi, replacement: 'ghp-<redacted>' },
  { pattern: /\bAKIA[A-Z0-9]{12,}\b/g, replacement: 'AKIA<redacted>' },
  { pattern: /\bcocos_session=[^\s;,'"]+/gi, replacement: 'cocos_session=<keychain>' },
  { pattern: /\b(?:api[_-]?key|apikey)\s*[:=]\s*[^\s;,'"]+/gi, replacement: 'api_key=<redacted>' },
  { pattern: /\bBearer\s+[a-zA-Z0-9._-]{20,}/gi, replacement: 'Bearer <redacted>' },
  { pattern: /\beyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, replacement: 'eyJ<redacted-jwt>' },
];

function redact(text) {
  let out = text;
  for (const { pattern, replacement } of SECRET_REDACT) out = out.replace(pattern, replacement);
  return out;
}

function shouldSkip(content) {
  const stripped = content
    .replace(/\[事实\]\s*/g, '')
    .replace(/<redacted[^>]*>/gi, '')
    .replace(/<keychain>/gi, '')
    .trim();
  return stripped.length < 8;
}

function truncate(content) {
  if (content.length <= MAX_FACT_CHARS) return content;
  return content.slice(0, MAX_FACT_CHARS) + '\n…（事实已截断，详见原 workspace 交付物）';
}

function factIdFromContent(content) {
  const norm = content.replace(/\s+/g, ' ').trim().toLowerCase();
  return `kn-${crypto.createHash('sha256').update(norm).digest('hex').slice(0, 12)}`;
}

function titleFromFact(content) {
  const body = content.replace(/^\[事实\]\s*/, '').trim();
  const oneLine = body.split('\n')[0] ?? body;
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}…` : oneLine;
}

function serializeKnowledge(record) {
  return [
    `# ${record.title}`,
    '',
    '<!-- meta',
    `id: ${record.id}`,
    `tags: ${record.tags.join(', ')}`,
    `ts: ${record.ts}`,
    `source: ${record.sourceAgentId ?? 'unknown'}`,
    `workspace: ${record.workspaceId ?? ''}`,
    '-->',
    '',
    record.content,
  ].join('\n');
}

function serializeSkill(skill) {
  return [
    `# ${skill.title}`,
    '',
    '<!-- meta',
    `id: ${skill.id}`,
    `category: ${skill.category}`,
    `tags: ${skill.tags.join(', ')}`,
    `ts: ${skill.ts}`,
    `source: ${skill.sourceAgentId ?? 'unknown'}`,
    '-->',
    '',
    skill.content,
  ].join('\n');
}

const CONCURRENCY = Number(process.env.DRIVE9_MIGRATE_CONCURRENCY || 24);

async function drive9Write(filePath, content) {
  if (DRY) return;
  const url = base + (filePath.startsWith('/') ? filePath : `/${filePath}`);
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/octet-stream',
    },
    body: content,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`write ${filePath}: ${res.status} ${t}`);
  }
}

/** Run async workers with a concurrency cap. */
async function mapPool(items, limit, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

async function drive9List(dirPath) {
  const p = dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
  const res = await fetch(`${base}${p}?list=1`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`list ${dirPath}: ${res.status}`);
  const data = await res.json();
  return data?.entries ?? [];
}

function walkFiles(root, predicate) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === '.git') continue;
        stack.push(full);
      } else if (ent.isFile() && predicate(full)) {
        out.push(full);
      }
    }
  }
  return out;
}

function agentSidFromRoot(name) {
  return name;
}

function parseSkillMd(raw, fallbackId, sourceAgentId) {
  const lines = raw.split('\n');
  const title = lines[0]?.replace(/^#\s*/, '').trim() || fallbackId;
  const metaStart = lines.findIndex((l) => l.trim() === '<!-- meta');
  const metaEnd = lines.findIndex((l, i) => i > metaStart && l.trim() === '-->');
  let id = fallbackId;
  let category = 'general';
  let tags = [];
  let ts = new Date().toISOString();
  let source = sourceAgentId;
  if (metaStart >= 0 && metaEnd > metaStart) {
    for (let i = metaStart + 1; i < metaEnd; i++) {
      const [key, ...rest] = (lines[i] ?? '').split(':');
      const val = rest.join(':').trim();
      switch (key?.trim()) {
        case 'id':
          id = val || id;
          break;
        case 'category':
          category = val || category;
          break;
        case 'tags':
          tags = val.split(',').map((t) => t.trim()).filter(Boolean);
          break;
        case 'ts':
          ts = val || ts;
          break;
        case 'source':
          source = val || source;
          break;
      }
    }
  }
  const contentStart = metaEnd >= 0 ? metaEnd + 1 : 2;
  const content = lines.slice(contentStart).join('\n').trim() || raw.trim();
  // infer category from path segments if still general
  return { id, category, title, tags, content, ts, sourceAgentId: source };
}

const writtenFacts = new Set();
const writtenSkills = new Set();
const stats = {
  memoryFiles: 0,
  factsSeen: 0,
  factsSkippedSeed: 0,
  factsSkippedInactive: 0,
  factsSkippedShort: 0,
  factsSkippedExisting: 0,
  factsDeduped: 0,
  factsWritten: 0,
  skillsSeen: 0,
  skillsSkippedExisting: 0,
  skillsDeduped: 0,
  skillsWritten: 0,
  errors: 0,
};

async function loadExistingIds(dirPath) {
  const entries = await drive9List(dirPath);
  const ids = new Set();
  for (const e of entries) {
    if (e.isDir) continue;
    const name = String(e.name || '');
    if (name.endsWith('.md')) ids.add(name.slice(0, -3));
  }
  return ids;
}

async function importFacts() {
  const existing = await loadExistingIds('/knowledge/shared');
  console.log(`[migrate] existing knowledge files: ${existing.size}`);
  /** @type {{ path: string, body: string, id: string }[]} */
  const jobs = [];

  for (const [agentName, dir] of DATA_ROOTS) {
    const root = path.join(SERVER, dir);
    const mems = walkFiles(root, (f) => f.replace(/\\/g, '/').endsWith('/.brain/memory.json'));
    for (const memPath of mems) {
      stats.memoryFiles += 1;
      let j;
      try {
        j = JSON.parse(fs.readFileSync(memPath, 'utf8'));
      } catch {
        continue;
      }
      const workspaceId = path.basename(path.dirname(path.dirname(memPath)));
      const records = Array.isArray(j.fact_records) ? j.fact_records : [];
      for (const fact of records) {
        stats.factsSeen += 1;
        if (fact?.status && fact.status !== 'active') {
          stats.factsSkippedInactive += 1;
          continue;
        }
        const via = fact?.source?.via ?? fact?.via;
        if (via === 'seed' || String(fact?.topic ?? '').startsWith('drive9.')) {
          stats.factsSkippedSeed += 1;
          continue;
        }
        let content = String(fact.content ?? '').trim();
        if (!content) continue;
        if (!content.startsWith('[事实]')) content = `[事实] ${content}`;
        content = truncate(redact(content));
        if (shouldSkip(content)) {
          stats.factsSkippedShort += 1;
          continue;
        }
        const id =
          typeof fact.id === 'string' && fact.id.startsWith('kn-')
            ? fact.id
            : factIdFromContent(content);
        if (writtenFacts.has(id)) {
          stats.factsDeduped += 1;
          continue;
        }
        writtenFacts.add(id);
        if (existing.has(id)) {
          stats.factsSkippedExisting += 1;
          continue;
        }
        const tags = new Set(['fact', 'migrated', agentName]);
        for (const t of fact.tags ?? []) if (t) tags.add(String(t));
        if (fact.topic) tags.add(String(fact.topic));
        const record = {
          id,
          title: titleFromFact(content),
          tags: [...tags].slice(0, 12),
          content,
          ts: fact.source?.at ?? new Date().toISOString(),
          sourceAgentId: agentName,
          workspaceId,
        };
        jobs.push({
          path: `/knowledge/shared/${id}.md`,
          body: serializeKnowledge(record),
          id,
        });
      }
    }
  }

  console.log(`[migrate] facts to write: ${jobs.length} (concurrency=${CONCURRENCY})`);
  await mapPool(jobs, CONCURRENCY, async (job) => {
    try {
      await drive9Write(job.path, job.body);
      stats.factsWritten += 1;
      if (stats.factsWritten % 100 === 0 || stats.factsWritten === jobs.length) {
        process.stdout.write(`  facts written ${stats.factsWritten}/${jobs.length}\r`);
      }
    } catch (e) {
      stats.errors += 1;
      console.warn(`\n[fact] ${job.id}: ${e.message}`);
    }
  });
}

async function importSkills() {
  const existing = await loadExistingIds('/skills/shared');
  console.log(`[migrate] existing skill files: ${existing.size}`);
  /** @type {{ path: string, body: string, id: string }[]} */
  const jobs = [];

  for (const [agentName, dir] of DATA_ROOTS) {
    const root = path.join(SERVER, dir);
    const skillFiles = walkFiles(root, (f) => {
      const n = f.replace(/\\/g, '/');
      return n.includes('/.brain/skills/') && n.endsWith('.md') && !n.endsWith('/skills.md');
    });
    for (const skillPath of skillFiles) {
      stats.skillsSeen += 1;
      let raw;
      try {
        raw = fs.readFileSync(skillPath, 'utf8');
      } catch {
        continue;
      }
      if (!raw.trim()) continue;
      const baseName = path.basename(skillPath, '.md');
      const rel = skillPath.replace(/\\/g, '/');
      const catMatch = rel.match(/\/\.brain\/skills\/([^/]+)\//);
      const category = catMatch?.[1] ?? 'general';
      const skill = parseSkillMd(raw, baseName, agentName);
      if (skill.category === 'general' && category !== 'general') skill.category = category;
      let id = skill.id;
      if (!id || id === baseName) {
        const hash = crypto.createHash('sha256').update(skill.content).digest('hex').slice(0, 12);
        id = `${baseName.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'skill'}-${hash}`;
      }
      if (writtenSkills.has(id)) {
        stats.skillsDeduped += 1;
        continue;
      }
      writtenSkills.add(id);
      if (existing.has(id)) {
        stats.skillsSkippedExisting += 1;
        continue;
      }
      skill.id = id;
      skill.tags = [...new Set([...(skill.tags ?? []), 'migrated', agentName])].slice(0, 12);
      jobs.push({
        path: `/skills/shared/${id}.md`,
        body: serializeSkill(skill),
        id,
      });
    }
  }

  console.log(`[migrate] skills to write: ${jobs.length}`);
  await mapPool(jobs, CONCURRENCY, async (job) => {
    try {
      await drive9Write(job.path, job.body);
      stats.skillsWritten += 1;
      if (stats.skillsWritten % 50 === 0 || stats.skillsWritten === jobs.length) {
        process.stdout.write(`  skills written ${stats.skillsWritten}/${jobs.length}\r`);
      }
    } catch (e) {
      stats.errors += 1;
      console.warn(`\n[skill] ${job.id}: ${e.message}`);
    }
  });
}

async function main() {
  console.log(`[migrate] Drive9 ${apiUrl} dry=${DRY}`);
  const rootList = await drive9List('/');
  console.log(`[migrate] root entries: ${rootList.map((e) => e.name).join(', ') || '(empty)'}`);

  if (!SKILLS_ONLY) {
    console.log('[migrate] importing facts (skip seed/drive9.*) …');
    await importFacts();
    console.log(`\n[migrate] facts done written=${stats.factsWritten}`);
  }
  if (!FACTS_ONLY) {
    console.log('[migrate] importing skills …');
    await importSkills();
    console.log(`\n[migrate] skills done written=${stats.skillsWritten}`);
  }

  console.log(JSON.stringify(stats, null, 2));
  const kn = await drive9List('/knowledge/shared');
  const sk = await drive9List('/skills/shared').catch(() => []);
  console.log(`[migrate] drive9 knowledge/shared files≈${kn.length} skills/shared≈${sk.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

import fs from 'node:fs';
import path from 'node:path';
import { getWorkDir } from './workdir-guard.js';
import type { Tool } from '../index.js';

/**
 * Number of lines to include around a keyword match in raw messages.
 * Keeps returned snippets small while preserving enough context.
 */
const SNIPPET_CONTEXT_LINES = 4;

/** Maximum characters returned per matched snippet to avoid context bloat. */
const MAX_SNIPPET_CHARS = 400;

interface ArchiveSection {
  file: string;
  summary: string;
  rawBlocks: string[]; // raw message paragraphs split by "---"
}

function parseArchive(absPath: string): ArchiveSection | null {
  let raw: string;
  try {
    raw = fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }

  const summaryMatch = raw.match(/## Summary\n([\s\S]*?)(?:\n## |$)/);
  const rawMatch = raw.match(/## Raw Messages\n([\s\S]*)$/);

  const summary = summaryMatch?.[1]?.trim() ?? '';
  const rawBlocks = rawMatch?.[1]
    ?.split(/\n---\n/)
    .map(b => b.trim())
    .filter(Boolean) ?? [];

  return { file: path.basename(absPath), summary, rawBlocks };
}

function scoreText(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  return keywords.reduce((n, kw) => n + (lower.includes(kw) ? 1 : 0), 0);
}

function snippet(text: string, keywords: string[]): string {
  const lines = text.split('\n');
  let bestLine = 0;
  let bestScore = 0;
  lines.forEach((line, i) => {
    const s = scoreText(line, keywords);
    if (s > bestScore) { bestScore = s; bestLine = i; }
  });
  const start = Math.max(0, bestLine - SNIPPET_CONTEXT_LINES);
  const end = Math.min(lines.length, bestLine + SNIPPET_CONTEXT_LINES + 1);
  const excerpt = lines.slice(start, end).join('\n');
  return excerpt.length > MAX_SNIPPET_CHARS
    ? excerpt.slice(0, MAX_SNIPPET_CHARS) + '…'
    : excerpt;
}

export const seekContextTool: Tool = {
  name: 'seek_context',
  description:
    'Search through archived conversation context files in the working directory. ' +
    'Returns concise summaries and relevant excerpts matching the query — ' +
    'use this instead of read_file when looking for past conversation history, ' +
    'to avoid loading full files into context.',
  parameters: {
    query: {
      type: 'string',
      description: 'What you are looking for (keywords or a short question)',
    },
    max_results: {
      type: 'number',
      description: 'Maximum number of archive snippets to return (default 3)',
    },
  },
  required: ['query'],

  async call(args): Promise<{ ok: boolean; output: string }> {
    const query = String(args['query'] ?? '').trim();
    if (!query) return { ok: false, output: 'Missing required argument: query' };

    const maxResults = Math.min(Number(args['max_results'] ?? 3), 10);
    const workDir = getWorkDir();
    const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 1);

    // Discover all context-archive-*.md files sorted newest-first
    let archiveFiles: string[];
    try {
      archiveFiles = fs
        .readdirSync(workDir)
        .filter(f => f.startsWith('context-archive-') && f.endsWith('.md'))
        .sort()
        .reverse()
        .map(f => path.join(workDir, f));
    } catch {
      return { ok: true, output: 'No context archives found.' };
    }

    if (archiveFiles.length === 0) {
      return { ok: true, output: 'No context archives found.' };
    }

    interface Hit { score: number; text: string }
    const hits: Hit[] = [];

    for (const absPath of archiveFiles) {
      const archive = parseArchive(absPath);
      if (!archive) continue;

      // Always include the summary if it scores > 0
      const summaryScore = scoreText(archive.summary, keywords);
      if (summaryScore > 0 || archiveFiles.length === 1) {
        hits.push({
          score: summaryScore + 1, // slight boost for summaries
          text: `**[${archive.file} — Summary]**\n${archive.summary}`,
        });
      }

      // Search raw message blocks for matching snippets
      for (const block of archive.rawBlocks) {
        const blockScore = scoreText(block, keywords);
        if (blockScore > 0) {
          hits.push({
            score: blockScore,
            text: `**[${archive.file} — Excerpt]**\n${snippet(block, keywords)}`,
          });
        }
      }
    }

    if (hits.length === 0) {
      return { ok: true, output: `No matches found for: "${query}"` };
    }

    hits.sort((a, b) => b.score - a.score);
    const results = hits.slice(0, maxResults).map(h => h.text).join('\n\n---\n\n');
    return { ok: true, output: results };
  },
};

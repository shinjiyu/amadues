/**
 * 页面摘要：a11y 树格式化 + 短 inline 摘要（token 友好）。
 *
 * ADL：doc/structurizr/BROWSER-SESSION-TOOL.md §2.2
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A11yNode = { role?: string; name?: string; children?: A11yNode[] };

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_LINES = 100;

export function formatA11yTree(
  root: A11yNode | null,
  opts: { maxDepth?: number; maxLines?: number } = {},
): string {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  const lines: string[] = [];

  function walk(node: A11yNode | undefined, depth: number): void {
    if (!node || lines.length >= maxLines || depth > maxDepth) return;
    const role = node.role ?? 'generic';
    const name = node.name?.trim();
    const indent = '  '.repeat(depth);
    const label = name ? `${role} "${name}"` : role;
    lines.push(`${indent}- ${label}`);
    for (const child of node.children ?? []) {
      walk(child, depth + 1);
    }
  }

  walk(root ?? undefined, 0);
  if (lines.length >= maxLines) {
    lines.push('…[snapshot truncated]…');
  }
  return lines.join('\n');
}

export function inlinePageSummary(url: string, title: string, treeText: string): string {
  const firstLines = treeText.split('\n').slice(0, 8).join('\n');
  return `url=${url}\ntitle=${title}\n${firstLines}`;
}

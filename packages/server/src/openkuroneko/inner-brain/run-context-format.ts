/**
 * 将 RunContext 格式化为 Attributor prompt 片段（截断保底）。
 */

import type { ExecutionEntry } from '../brain/index.js';
import type { RunContext } from './run-context-store.js';

const ENTRY_RESULT_MAX = 1500;
const RAW_TAIL_MAX = 800;
const MAX_ENTRIES_PER_NODE = 40;

function formatEntry(e: ExecutionEntry, idx: number): string {
  const resultStr = JSON.stringify(e.result);
  const resultDisplay =
    resultStr.length > ENTRY_RESULT_MAX
      ? `${resultStr.slice(0, ENTRY_RESULT_MAX)}…（${resultStr.length} 字符）`
      : resultStr;
  return [
    `#### 操作 ${idx + 1}`,
    `工具：${e.toolName}`,
    `参数：${JSON.stringify(e.args)}`,
    `结果：${resultDisplay}`,
    e.error ? `错误：${e.error}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatRunContextForPrompt(ctx: RunContext): string {
  if (ctx.nodes.length === 0) return '（无节点执行记录）';

  return ctx.nodes
    .map(n => {
      const head = `### 节点 ${n.nodeInstId} (${n.ref}) [${n.ok ? 'ok' : n.status ?? 'failed'}]`;
      const meta = [
        n.instruction ? `instruction: ${n.instruction}` : '',
        n.deliverable ? `deliverable: ${n.deliverable}` : '',
        n.failureSummary ? `failure: ${n.failureSummary}` : '',
        n.rawTail
          ? `rawTail: ${n.rawTail.length > RAW_TAIL_MAX ? `${n.rawTail.slice(0, RAW_TAIL_MAX)}…` : n.rawTail}`
          : '',
      ]
        .filter(Boolean)
        .join('\n');
      const entries = n.entries.slice(0, MAX_ENTRIES_PER_NODE);
      const log =
        entries.length === 0
          ? '（无工具调用）'
          : entries.map((e, i) => formatEntry(e, i)).join('\n\n');
      const omitted =
        n.entries.length > MAX_ENTRIES_PER_NODE
          ? `\n…（省略 ${n.entries.length - MAX_ENTRIES_PER_NODE} 条工具记录）`
          : '';
      return [head, meta, log + omitted].filter(Boolean).join('\n\n');
    })
    .join('\n\n---\n\n');
}

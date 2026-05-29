/**
 * write_memo — 内脑向外脑传递任务发现/结论
 *
 * 内脑执行中如果发现了**外脑（和用户）可能感兴趣**的信息，用此工具写入 mem9。
 * 外脑对话时会从 mem9 语义召回这些内容来回答用户。
 *
 * 适用场景（举例）：
 *   - "发现 bug 根因在 foo.ts:42，原因是空指针"
 *   - "该接口返回格式是 { code, data, msg }，已确认"
 *   - "依赖版本冲突：react@18 与 @types/react@17 不兼容"
 *   - "任务已完成，产物在 dist/output.json"
 *
 * 不适合写入（应用 write_skill / write_knowledge）：
 *   - 可复用的操作步骤（→ write_skill）
 *   - 客观环境事实（→ write_knowledge）
 */

import { formatAgentTimestampShort } from '../../../agent-time.js';
import { Mem9Client } from '../../../mem9/mem9-client.js';
import type { Tool } from '../index.js';

let _mem9: Mem9Client | null | undefined;

function getMem9(): Mem9Client | null {
  if (_mem9 !== undefined) return _mem9;
  const apiKey = process.env['MEM9_API_KEY'];
  _mem9 = apiKey ? new Mem9Client({ apiKey }) : null;
  return _mem9;
}

/** 外脑 agent_id（内脑写入到外脑的命名空间，外脑才能召回） */
function getOuterAgentId(): string {
  // 与外脑 OuterMemoryStore 保持一致：${agentSid}:tasks
  const sid = process.env['UTLRA_AGENT_IM_SID'] ?? 'idp:agent:assistant';
  return `${sid}:tasks`;
}

export const writeMemoTool: Tool = {
  name: 'write_memo',
  description:
    '将任务执行中的重要发现或结论写入外脑记忆（mem9），让外脑在回答用户时能够引用。\n\n' +
    '适合写入：bug 根因、接口格式确认、任务关键进展、异常现象分析、产物位置等。\n' +
    '不适合写入：可复用操作步骤（用 write_skill）、纯本地环境事实（用 write_knowledge）。\n\n' +
    'summary：一句话摘要（外脑搜索时用）\n' +
    'detail：详细内容（可多行，支持 Markdown）',
  parameters: {
    summary: {
      type: 'string',
      description: '一句话摘要，外脑语义搜索的关键信息',
    },
    detail: {
      type: 'string',
      description: '详细内容，支持 Markdown，可包含代码片段、数据结构等',
    },
  },
  required: ['summary'],
  async call(args) {
    const summary = String(args['summary'] ?? '').trim();
    const detail  = String(args['detail']  ?? '').trim();
    if (!summary) return { ok: false, output: '缺少必需参数: summary' };

    const mem9 = getMem9();
    if (!mem9) {
      return { ok: false, output: 'MEM9_API_KEY 未配置，无法写入外脑记忆' };
    }

    const ts      = formatAgentTimestampShort();
    const header  = `[内脑发现 ${ts}] ${summary}`;
    const content = detail ? `${header}\n\n${detail}` : header;
    const agentId = getOuterAgentId();

    void mem9
      .store({ content, agentId, metadata: { ts: new Date().toISOString(), type: 'memo', summary } })
      .catch((e: unknown) =>
        console.warn('[write_memo] mem9 store failed:', (e as Error).message),
      );

    return {
      ok: true,
      output: `已发送到外脑记忆（agentId: ${agentId}）：${summary.slice(0, 60)}`,
    };
  },
};

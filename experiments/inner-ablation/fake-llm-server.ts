/**
 * --fake 冒烟用的 OpenAI 兼容 chat/completions 服务：按 system prompt 标记路由到
 * Designer / Attributor / baseNode，只为把 fake-hello 跑通，验证编排与指标链路。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { FAKE_HELLO_FILE, FAKE_HELLO_TEXT } from './tasks/fake-hello/task.ts';

interface ChatMessage {
  role: string;
  content?: unknown;
}

interface ChatBody {
  stream?: boolean;
  messages?: ChatMessage[];
}

interface Reply {
  content: string;
  toolCalls: { name: string; args: Record<string, unknown> }[];
}

export type FakeRole = 'designer' | 'attributor' | 'baseNode' | 'other';

export interface FakeLlmServer {
  baseUrl: string;
  calls: FakeRole[];
  close(): Promise<void>;
}

const text = (c: unknown): string => (typeof c === 'string' ? c : JSON.stringify(c ?? ''));

function route(body: ChatBody): { role: FakeRole; reply: Reply } {
  const msgs = body.messages ?? [];
  const system = text(msgs.find(m => m.role === 'system')?.content);
  const rest = msgs.filter(m => m.role !== 'system');
  const restText = rest.map(m => text(m.content)).join('\n');

  if (system.includes('baseNode 执行器')) {
    const toolDone = rest.some(m => m.role === 'tool');
    return {
      role: 'baseNode',
      reply: toolDone
        ? { content: `已写入 ${FAKE_HELLO_FILE}`, toolCalls: [] }
        : { content: '', toolCalls: [{ name: 'write_file', args: { path: FAKE_HELLO_FILE, content: FAKE_HELLO_TEXT } }] },
    };
  }
  if (system.includes('强制归因器')) {
    return { role: 'attributor', reply: { content: '节点成功，无需修正。', toolCalls: [] } };
  }
  if (system.includes('Designer')) {
    const verify = [{ kind: 'file', target: FAKE_HELLO_FILE }];
    if (restText.includes('(preset/base): ok')) {
      return { role: 'designer', reply: { content: '', toolCalls: [{ name: 'report_done', args: { reason: 'hello written', verify } }] } };
    }
    return {
      role: 'designer',
      reply: {
        content: '',
        toolCalls: [
          {
            name: 'commit_local_dag',
            args: {
              nodes: [
                {
                  id: 'hello',
                  ref: 'preset/base',
                  instruction: `写 ${FAKE_HELLO_FILE}`,
                  deliverable: { summary: 'hello 文件', checks: verify },
                },
              ],
            },
          },
        ],
      },
    };
  }
  return { role: 'other', reply: { content: 'ok', toolCalls: [] } };
}

const USAGE = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };

function writeStream(res: http.ServerResponse, reply: Reply): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  if (reply.content) send({ choices: [{ index: 0, delta: { content: reply.content } }] });
  reply.toolCalls.forEach((tc, index) =>
    send({
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index, id: `call_${index}_${Date.now()}`, function: { name: tc.name, arguments: JSON.stringify(tc.args) } }] },
        },
      ],
    }),
  );
  send({ choices: [{ index: 0, delta: {}, finish_reason: reply.toolCalls.length ? 'tool_calls' : 'stop' }] });
  send({ choices: [], usage: USAGE });
  res.end('data: [DONE]\n\n');
}

function writeJson(res: http.ServerResponse, reply: Reply): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      choices: [
        {
          index: 0,
          finish_reason: reply.toolCalls.length ? 'tool_calls' : 'stop',
          message: {
            role: 'assistant',
            content: reply.content,
            ...(reply.toolCalls.length
              ? {
                  tool_calls: reply.toolCalls.map((tc, i) => ({
                    id: `call_${i}_${Date.now()}`,
                    type: 'function',
                    function: { name: tc.name, arguments: JSON.stringify(tc.args) },
                  })),
                }
              : {}),
          },
        },
      ],
      usage: USAGE,
    }),
  );
}

export function startFakeLlmServer(): Promise<FakeLlmServer> {
  const calls: FakeRole[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      if (!(req.url ?? '').endsWith('/chat/completions')) {
        res.writeHead(404);
        res.end();
        return;
      }
      let body: ChatBody;
      try {
        body = JSON.parse(raw) as ChatBody;
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      const { role, reply } = route(body);
      calls.push(role);
      if (body.stream) writeStream(res, reply);
      else writeJson(res, reply);
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        calls,
        close: () => new Promise(r => server.close(() => r())),
      });
    });
  });
}

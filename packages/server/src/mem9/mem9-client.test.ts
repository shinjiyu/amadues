/**
 * mem9 功能集成测试
 *
 * 全程使用真实 API，beforeAll 自动注册 Tenant（无需人工操作）。
 *
 * 关键 API 特性（已通过探测确认）：
 *   - store() 完全异步，LLM 后台处理，返回 {status:"accepted"}
 *   - LLM 可能改写/压缩内容，并自动加标签
 *   - search() 通过 ?agent_id= 过滤，不是 header
 *   - 无效 key 返回 400（非 401）
 *
 * 环境变量：
 *   MEM9_API_URL  默认 https://api.mem9.ai
 *   MEM9_API_KEY  可选；不设置时自动 provision 一个新 Tenant
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Mem9Client, Mem9Error, type Memory } from './mem9-client.js';

const API_URL = process.env['MEM9_API_URL'] ?? 'https://api.mem9.ai';

/** 等待 LLM 异步处理完成 */
function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * 等待直到搜索到满足条件的记忆（轮询）
 * 最多等 maxWaitMs，每次间隔 intervalMs
 */
async function waitForMemory(
  client: Mem9Client,
  opts: { query?: string; agentId?: string },
  predicate: (memories: Memory[]) => boolean,
  maxWaitMs = 15_000,
  intervalMs = 2_000,
): Promise<Memory[]> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const results = await client.search({ query: opts.query, agentId: opts.agentId });
    if (predicate(results)) return results;
    await sleep(intervalMs);
  }
  // 超时后返回最后一次结果
  return client.search({ query: opts.query, agentId: opts.agentId });
}

let client: Mem9Client;
let apiKey: string;

// ── 自动注册 Tenant ──────────────────────────────────────────────────────────

beforeAll(async () => {
  if (process.env['MEM9_API_KEY']) {
    apiKey = process.env['MEM9_API_KEY'];
    console.log(`[mem9 test] 使用已有 API Key: ${apiKey}`);
  } else {
    const result = await Mem9Client.provision(API_URL);
    apiKey = result.id;
    console.log(`[mem9 test] 自动注册新 Tenant，API Key: ${apiKey}`);
    console.log(`[mem9 test] Dashboard: https://mem9.ai/your-memory`);
  }

  client = new Mem9Client({ apiUrl: API_URL, apiKey });
});

// ── 模块 1：基础 CRUD ────────────────────────────────────────────────────────

describe('模块1: 基础 CRUD', () => {
  let foundId: string;

  it('C1: store 返回 accepted（异步写入）', async () => {
    const res = await client.store({
      content: 'CRUD测试条目：TypeScript 类型系统与泛型约束',
      agentId: 'test-crud',
    });
    expect(res.status).toBe('accepted');
  });

  it('C2: 等待 LLM 处理后可通过搜索找到该记忆', async () => {
    const results = await waitForMemory(
      client,
      { query: 'TypeScript 泛型', agentId: 'test-crud' },
      (mems) => mems.length > 0,
    );
    expect(results.length).toBeGreaterThan(0);
    foundId = results[0]!.id;
    console.log(`[C2] 找到记忆 id=${foundId}, content=${results[0]!.content.slice(0, 60)}`);
  });

  it('C3: 按 ID 读取，字段完整', async () => {
    const mem = await client.get(foundId);
    expect(mem.id).toBe(foundId);
    expect(mem.content).toBeTruthy();
    expect(mem.agent_id).toBe('test-crud');
  });

  it('C4: 更新记忆内容', async () => {
    await client.update(foundId, { content: 'TypeScript 类型系统与泛型约束（已更新）' });
    // 更新同样是异步的，稍作等待
    await sleep(3_000);
    const mem = await client.get(foundId);
    // LLM 可能改写，不做精确匹配，只验证 id 仍存在
    expect(mem.id).toBe(foundId);
  });

  it('C5: 删除记忆，再次 GET 返回 404', async () => {
    await client.delete(foundId);
    await expect(client.get(foundId)).rejects.toMatchObject({ status: 404 });
  });

  it('C6: 读取不存在的 ID，抛出 Mem9Error(404)', async () => {
    const err = await client.get('nonexistent-id-00000000').catch((e) => e);
    expect(err).toBeInstanceOf(Mem9Error);
    expect((err as Mem9Error).status).toBe(404);
  });
});

// ── 模块 2：Agent ID 隔离（核心验证）────────────────────────────────────────

describe('模块2: Agent ID 隔离', () => {
  const stamp = Date.now(); // 用时间戳让内容唯一，避免与旧数据混淆

  beforeAll(async () => {
    await Promise.all([
      client.store({ content: `Kuro专属记录-${stamp}：今天实现了记忆层设计方案`, agentId: 'iso-kuro' }),
      client.store({ content: `Shiro专属记录-${stamp}：今天修复了内脑崩溃问题`, agentId: 'iso-shiro' }),
      client.store({ content: `团队共享知识-${stamp}：monorepo 使用 npm workspaces 管理`, agentId: 'iso-shared' }),
    ]);
    // 等 LLM 处理
    await sleep(8_000);
  });

  it('I1: agent_id 过滤正常，Kuro 的记忆只含 iso-kuro', async () => {
    const results = await client.search({ agentId: 'iso-kuro' });
    expect(results.length).toBeGreaterThan(0);
    for (const m of results) {
      expect(m.agent_id).toBe('iso-kuro');
    }
  });

  it('I2: agent_id 过滤正常，Shiro 的记忆只含 iso-shiro', async () => {
    const results = await client.search({ agentId: 'iso-shiro' });
    expect(results.length).toBeGreaterThan(0);
    for (const m of results) {
      expect(m.agent_id).toBe('iso-shiro');
    }
  });

  it('I3: Kuro 搜索不会出现 Shiro 的记忆', async () => {
    const results = await client.search({ query: '内脑崩溃', agentId: 'iso-kuro' });
    for (const m of results) {
      expect(m.agent_id).not.toBe('iso-shiro');
    }
  });

  it('I4: 共享 agent 的记忆可被 iso-shared 过滤查到', async () => {
    const results = await client.search({ agentId: 'iso-shared' });
    expect(results.length).toBeGreaterThan(0);
    for (const m of results) {
      expect(m.agent_id).toBe('iso-shared');
    }
  });

  it('I5: 不带 agent_id 过滤时可看到多个 agent 的记忆', async () => {
    const results = await client.search({});
    const agentIds = new Set(results.map((m) => m.agent_id));
    // 应该能看到多个 agent 的数据
    expect(agentIds.size).toBeGreaterThan(1);
  });
});

// ── 模块 3：语义检索质量 ─────────────────────────────────────────────────────

describe('模块3: 语义检索质量', () => {
  // LLM 只存储"有意义的事实"，内容必须是陈述句而非标题
  const agentId = `sem-${Date.now()}`;

  it('S1: 语义相近查询能命中相关记忆（中文近义词）', async () => {
    await client.store({
      content: '团队遇到了 TypeScript 编译报错，发现是类型断言使用不当导致的类型不安全问题',
      agentId,
    });
    const results = await waitForMemory(
      client,
      { query: 'TS类型报错怎么解决', agentId },
      (mems) => mems.length > 0,
    );
    expect(results.length).toBeGreaterThan(0);
    console.log(`[S1] Top 结果: ${results[0]!.content}`);
  });

  it('S2: 语义相近查询能命中相关记忆（技术关键词）', async () => {
    await client.store({
      content: '团队通过 useMemo 和 useCallback 优化了 React 组件的渲染性能，页面卡顿明显减少',
      agentId,
    });
    const results = await waitForMemory(
      client,
      { query: 'React hook 性能调优', agentId },
      (mems) => mems.length > 0,
    );
    expect(results.length).toBeGreaterThan(0);
    console.log(`[S2] Top 结果: ${results[0]!.content}`);
  });

  it('S3: 空结果场景不崩溃，返回数组', async () => {
    const results = await client.search({
      query: '量子纠缠与宇宙暗物质',
      agentId: `empty-agent-${Date.now()}`,
    });
    expect(Array.isArray(results)).toBe(true);
  });
});

// ── 模块 4：utlraKuroneko 业务场景 ──────────────────────────────────────────

describe('模块4: 业务场景', () => {
  afterAll(async () => {
    // 清理本模块写入的测试数据
    const results = await client.search({ agentId: 'biz-kuro' });
    await Promise.allSettled(results.map((m) => client.delete(m.id)));
    const results2 = await client.search({ agentId: 'biz-shared' });
    await Promise.allSettled(results2.map((m) => client.delete(m.id)));
  });

  it('B1: 外脑写入聊天摘要，搜索"记忆方案"能找到', async () => {
    await client.store({
      content: '用户和外脑讨论了 mem9 多 Agent 记忆隔离方案，决定采用单 Key + agent_id 过滤',
      agentId: 'biz-kuro',
      metadata: { type: 'chat-summary', threadId: 'thread-biz-001' },
    });
    const results = await waitForMemory(
      client,
      { query: '多 Agent 记忆', agentId: 'biz-kuro' },
      (mems) => mems.length > 0,
    );
    expect(results.length).toBeGreaterThan(0);
    console.log(`[B1] 找到: ${results[0]!.content.slice(0, 60)}`);
  });

  it('B2: 写入任务状态，搜索"当前任务"能检索到', async () => {
    await client.store({
      content: '当前任务：完成 mem9 客户端集成测试，验证 Agent 隔离和语义搜索功能',
      agentId: 'biz-kuro',
      metadata: { type: 'task-state' },
    });
    const results = await waitForMemory(
      client,
      { query: '当前任务', agentId: 'biz-kuro' },
      (mems) => mems.length > 0,
    );
    expect(results.length).toBeGreaterThan(0);
  });

  it('B3: 内脑将学到的技巧写入共享池，其他 agent 能用语义查到', async () => {
    await client.store({
      content: '内脑工作技巧：vitest + tsx/esm 组合可在 ESM 项目中直接运行 TypeScript 测试无需编译',
      agentId: 'biz-shared',
      metadata: { type: 'skill', learnedBy: 'inner-brain' },
    });
    const results = await waitForMemory(
      client,
      { query: 'TypeScript 测试方案', agentId: 'biz-shared' },
      (mems) => mems.length > 0,
    );
    expect(results.length).toBeGreaterThan(0);
    // 验证共享记忆的 agent_id 是 biz-shared
    expect(results[0]!.agent_id).toBe('biz-shared');
  });
});

// ── 模块 5：错误与边界 ───────────────────────────────────────────────────────

describe('模块5: 错误与边界', () => {
  it('E1: 无效 API Key 发请求，得到 4xx 错误', async () => {
    const badClient = new Mem9Client({ apiUrl: API_URL, apiKey: 'invalid-key-00000' });
    const err = await badClient.store({ content: '测试' }).catch((e) => e);
    expect(err).toBeInstanceOf(Mem9Error);
    // mem9 返回 400（非标准 401，已实测确认）
    expect((err as Mem9Error).status).toBeGreaterThanOrEqual(400);
    expect((err as Mem9Error).status).toBeLessThan(500);
  });

  it('E2: 含 emoji、换行、引号的 content 被接受（store 返回 accepted）', async () => {
    const special = '😀 换行\n测试 引号"双引号" \'单引号\' 反斜杠\\结束';
    const res = await client.store({ content: special, agentId: 'test-edge' });
    expect(res.status).toBe('accepted');
    // LLM 会处理内容，不验证原样返回
  });

  it('E3: 超长文本（10k 字符）store 正常返回 accepted', async () => {
    const longContent = '这是一段超长的技术文档内容。'.repeat(800);
    const res = await client.store({ content: longContent, agentId: 'test-edge' });
    expect(res.status).toBe('accepted');
  });

  it('E4: 并发发送 5 个不同内容的 store，全部返回 accepted', async () => {
    const writes = Array.from({ length: 5 }, (_, i) =>
      client.store({
        content: `并发写入唯一条目 item-${i}-stamp-${Date.now()}-${Math.random()}`,
        agentId: 'test-concurrent',
      }),
    );
    const results = await Promise.all(writes);
    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r.status).toBe('accepted');
    }
  });
});

/**
 * mem9 API 延迟 Benchmark
 *
 * 测量各端点的 min / median / p95 / p99 / max 延迟。
 * 每个端点重复 N 次，输出统计表格。
 *
 * 运行：
 *   MEM9_API_KEY=<key> npx tsx src/mem9/mem9-latency.bench.ts
 * 或自动 provision：
 *   npx tsx src/mem9/mem9-latency.bench.ts
 *
 * 参考指标（LoCoMo benchmark 行业数据）：
 *   Mem0 search median latency ≈ 0.71s
 *   Mem0g search median latency ≈ 1.09s
 *   Full-context median ≈ 9.87s
 */

import { Mem9Client } from './mem9-client.js';

const API_URL   = process.env['MEM9_API_URL'] ?? 'https://api.mem9.ai';
const ROUNDS    = Number(process.env['BENCH_ROUNDS'] ?? '10');
const WARMUP    = Number(process.env['BENCH_WARMUP'] ?? '2');

// ── 统计工具 ──────────────────────────────────────────────────────────────────

function stats(samples: number[]): {
  min: number; max: number; mean: number;
  median: number; p95: number; p99: number;
} {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const pct = (p: number) => sorted[Math.ceil(p * n) - 1]!;
  const mean = samples.reduce((s, v) => s + v, 0) / n;
  return {
    min:    sorted[0]!,
    max:    sorted[n - 1]!,
    mean:   Math.round(mean),
    median: pct(0.5),
    p95:    pct(0.95),
    p99:    pct(0.99),
  };
}

function fmt(ms: number) { return `${ms}ms`; }

function printRow(label: string, s: ReturnType<typeof stats>, n: number) {
  console.log(
    `  ${label.padEnd(28)} ` +
    `min=${fmt(s.min).padStart(7)}  ` +
    `median=${fmt(s.median).padStart(7)}  ` +
    `p95=${fmt(s.p95).padStart(7)}  ` +
    `p99=${fmt(s.p99).padStart(7)}  ` +
    `max=${fmt(s.max).padStart(7)}  ` +
    `mean=${fmt(s.mean).padStart(7)}  ` +
    `(n=${n})`,
  );
}

// ── 计时包装 ──────────────────────────────────────────────────────────────────

async function measure<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const t0 = performance.now();
  const result = await fn();
  return { result, ms: Math.round(performance.now() - t0) };
}

async function bench(
  label: string,
  fn: () => Promise<unknown>,
  rounds = ROUNDS,
  warmup = WARMUP,
): Promise<void> {
  // warmup
  for (let i = 0; i < warmup; i++) {
    try { await fn(); } catch { /* ignore warmup errors */ }
  }
  const samples: number[] = [];
  for (let i = 0; i < rounds; i++) {
    try {
      const { ms } = await measure(fn);
      samples.push(ms);
    } catch (e) {
      console.warn(`  [${label}] round ${i} error:`, (e as Error).message);
    }
  }
  if (samples.length === 0) {
    console.log(`  ${label.padEnd(28)} ALL FAILED`);
    return;
  }
  printRow(label, stats(samples), samples.length);
}

// ── 主流程 ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'═'.repeat(110)}`);
  console.log(`  mem9 API Latency Benchmark`);
  console.log(`  API URL: ${API_URL}`);
  console.log(`  Rounds: ${ROUNDS}  Warmup: ${WARMUP}`);
  console.log(`${'═'.repeat(110)}\n`);

  // ── 1. Provision ─────────────────────────────────────────────────────────────
  console.log('▶ Provision (自动注册 Tenant)');
  let apiKey: string;
  if (process.env['MEM9_API_KEY']) {
    apiKey = process.env['MEM9_API_KEY'];
    console.log(`  使用已有 Key: ${apiKey}`);

    await bench('provision (POST /v1alpha1/mem9s)', () => Mem9Client.provision(API_URL));
  } else {
    const { result, ms } = await measure(() => Mem9Client.provision(API_URL));
    apiKey = result.id;
    console.log(`  新 Tenant Key: ${apiKey}  [first provision: ${ms}ms]`);
    // provision benchmark 需要单独 key 避免复用
    await bench('provision (POST /v1alpha1/mem9s)', () => Mem9Client.provision(API_URL));
  }

  const client = new Mem9Client({ apiUrl: API_URL, apiKey, agentId: 'bench-agent' });

  // 预先存入几条供 search/get 用的记忆
  console.log('\n  预写入测试数据...');
  const seedContents = [
    '团队使用 TypeScript 开发后端服务，发现严格模式可以减少大量运行时错误',
    '外脑通过心跳机制每5分钟检查内脑状态，发现异常时自动重启',
    '项目采用 monorepo 结构，所有包通过 npm workspaces 统一管理依赖',
    '内脑使用文件系统保存状态，支持随时中断并从断点恢复',
    '外脑的记忆层分为聊天记录和任务状态两部分，分别存储在不同文件中',
  ];
  await Promise.all(seedContents.map((content) => client.store({ content })));
  console.log('  等待 LLM 处理...');
  await new Promise((r) => setTimeout(r, 12_000));

  // 查一下有哪些 id 可以用
  const seedList = await client.search({});
  const sampleId = seedList[0]?.id ?? '';
  console.log(`  可用记忆数: ${seedList.length}, sampleId: ${sampleId}\n`);

  // ── 2. Write ──────────────────────────────────────────────────────────────────
  console.log('▶ Write');
  await bench('store (POST /v1alpha2/...)', () =>
    client.store({ content: `Bench写入测试 ${Date.now()}：团队今天完成了性能测试基准测量` }),
  );

  // ── 3. Search ────────────────────────────────────────────────────────────────
  console.log('\n▶ Search');
  await bench('search no-query (list all)', () =>
    client.search({}),
  );
  await bench('search q=TypeScript', () =>
    client.search({ query: 'TypeScript 开发' }),
  );
  await bench('search q=记忆 agentId=bench-agent', () =>
    client.search({ query: '记忆层设计', agentId: 'bench-agent' }),
  );
  await bench('search q=外脑心跳', () =>
    client.search({ query: '外脑心跳机制' }),
  );

  // ── 4. Read ──────────────────────────────────────────────────────────────────
  console.log('\n▶ Read');
  if (sampleId) {
    await bench(`get by id`, () => client.get(sampleId));
  } else {
    console.log('  get by id: 跳过（无可用记忆 id）');
  }

  // ── 5. Update ────────────────────────────────────────────────────────────────
  console.log('\n▶ Update');
  if (sampleId) {
    await bench('update by id', () =>
      client.update(sampleId, { content: '更新测试：团队在性能优化过程中发现了内存泄漏问题' }),
    );
  } else {
    console.log('  update by id: 跳过（无可用记忆 id）');
  }

  // ── 6. 并发吞吐 ──────────────────────────────────────────────────────────────
  console.log('\n▶ 并发吞吐（同时发 N 个请求，测总耗时）');
  for (const concurrency of [1, 3, 5, 10]) {
    const { ms } = await measure(() =>
      Promise.all(
        Array.from({ length: concurrency }, (_, i) =>
          client.search({ query: `并发测试 ${i}` }),
        ),
      ),
    );
    const perReq = Math.round(ms / concurrency);
    console.log(
      `  search × ${String(concurrency).padStart(2)} 并发`.padEnd(32) +
      `total=${fmt(ms).padStart(7)}  per-req≈${fmt(perReq).padStart(7)}`,
    );
  }

  // ── 汇总对比 ─────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(110)}`);
  console.log('  参考：LoCoMo benchmark 行业数据（来自 ECAI 2025, arXiv:2504.19413）');
  console.log('    Mem0   search median ≈  710ms');
  console.log('    Mem0g  search median ≈ 1090ms');
  console.log('    Full-context median  ≈ 9870ms');
  console.log(`${'═'.repeat(110)}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });

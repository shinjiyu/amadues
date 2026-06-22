# How to Write Tests (Quick Sheet)

> 配套设计：`doc/testing-strategy.md`。本文只讲**怎么动手**，不讲为什么。

## 1. 四种文件后缀

| 后缀 | 用法 | 默认运行 | LLM |
|------|------|----------|------|
| `*.test.ts` | 单元：单文件 / 单函数 / 纯逻辑 | ✅ | **禁止真实 LLM**；FakeLLM 仅用于不涉及 prompt 效果的兜底路径 |
| `*.integration.test.ts` | 模块：多文件协作，临时 workDir | ✅（独立 config） | 编排路径用 FakeLLM；涉及 prompt 效果的搬到 `.prompt.test.ts` |
| `*.prompt.test.ts` | **Prompt 效果**：测 prompt 设计能否让真实 LLM 产出预期格式 / 类别 | ✅（独立 config） | **真实 LLM**（缺 key 直接 fail） |
| `*.live.test.ts` | 真服务（mem9 / drive9 等真 API） | ❌（`VITEST_LIVE=1` 才跑） | 一般不调 LLM |

**怎么挑后缀**：

| 测试目的 | 选哪个 |
|----------|--------|
| 测「parseControlFlag 能识别 CONTROL: REPLAN」 | `.test.ts`（纯函数） |
| 测「prompt 能让 LLM 写出可被 parseControlFlag 识别的 flag」 | `.prompt.test.ts` |
| 测「LLM 抛错时业务 catch 返回 silent」 | `.test.ts`（FakeLLM 模拟抛错） |
| 测「跑一次 burst：goal → COMPLETE，状态机正确」 | `.integration.test.ts`（FakeLLM 脚本） |

## 2. 命令

```bash
# 在 packages/server
npm run test:unit         # 仅单元，最常用
npm run test:integration  # 仅模块
npm run test:prompt       # 仅 Prompt（真实 LLM；需根目录 .env 有 LLM key）
npm run test              # 上面三者串联（提交前签收）
npm run test:watch        # 开发时
```

## 3. 单元测试（90% 场景）

```ts
import { describe, it, expect } from 'vitest';
import { shouldAutoAchieveKpi } from './kpi-progress.js';

describe('shouldAutoAchieveKpi', () => {
  it('post-complete + 有产出 → true', () => {
    expect(
      shouldAutoAchieveKpi({
        successConfirmed: true,
        deliverableCount: 2,
        isAwaiting: false,
        exitedWithError: false,
        isPostComplete: true,
      }),
    ).toBe(true);
  });
});
```

**单测红线**：

- 不要 `process.env.X = '0'`（改注入 config）
- 不要 `fetch()`（改注入 LLM / HTTP client）
- 不要 `vi.useFakeTimers()`（改用 `createFakeClock`）
- 不要写大段 inline JSON（改用 `loadFixture`）
- 不要 `import` 跨模块的内部实现（外脑测试不 import 内脑 controller 内部）

## 4. 测 LLM 调用

### 4.1 不涉及 prompt 效果 → FakeLLM（`.test.ts`）

```ts
import { createFakeLLM } from '../testing/index.js';

const llm = createFakeLLM([
  { label: 'decomposer', match: 'decomposer', reply: { content: '[M1]\n[M2]' } },
  { label: 'attributor', match: 'attributor', reply: { content: '<COMPLETE>' } },
]);

await runDecomposer({ llm, /* ... */ });

expect(llm.calls).toHaveLength(1);
expect(llm.calls[0]!.matchedLabel).toBe('decomposer');
```

> 未命中脚本默认**抛错**——这是特性，强迫你显式列出每条预期路径。
> 真不想抛，传 `{ unmatched: 'silent', silentReply: '...' }`。

### 4.2 测 prompt 效果 → 真实 LLM（`.prompt.test.ts`）

**红线**：

- 文件名**必须**以 `.prompt.test.ts` 结尾。
- 顶层调 `requireLlmEnvForPrompt()`——缺 LLM key 时该文件**整体 fail**（这是设计，不要改成 skip）。
- 断言用语义匹配，**不要**精确字符串。
- 「类别正确」用软警告（`console.warn`）记录，**不要**硬断。

```ts
import { describe, it, expect } from 'vitest';
import { participationSpeakLlm } from './inbound-policy.js';
import { requireLlmEnvForPrompt } from '../testing/require-llm.js';

const llmEnv = requireLlmEnvForPrompt(); // ← 顶层调用；缺 key 这里抛错

describe('participationSpeakLlm · prompt 效果', () => {
  it('明显应静默场景 → 返回布尔（格式遵守）', async () => {
    const speak = await participationSpeakLlm(llmEnv, {
      content: '我们俩明早 8 点机场见',
      threadHistoryPrefix: 'Alice: 周末出去玩\nBob: 订了酒店',
      innerStatusSummary: '当前内脑无任务',
      proactiveLevel: 2,
    });
    // ✅ 硬断：函数能返回布尔（业务能正确解析 LLM 输出）
    expect(typeof speak).toBe('boolean');
    // ✅ 软警告：期望 false（SILENT），翻车也不 fail
    if (speak) console.warn('[prompt-test] 私事场景翻车 → SPEAK');
  });
});
```

**为什么不硬断「必须 SILENT」？** 单 LLM 调用本就抖动；硬断会让套件随机失败。
prompt test 只硬断「格式遵守」——LLM 实际输出格式是否能被业务侧解析。
**类别正确性**是 LLM 能力问题，靠人工跑 `test:prompt` 看 stdout 警告评估，
长期偏差则触发 prompt 迭代（改 system prompt）。

**maxTokens 警告**：GLM 等强制 thinking 模型即便传 `thinking: 'disabled'` 也不一定生效。
二分类调用至少给 **maxTokens ≥1024**，否则 thinking 吃光 budget → content=null → provider 抛 empty content。
（2026-05-17 prompt 测试体系上线即捕获此 bug，已修。）

## 5. 测 IM 出站：用 `FakeImChannel`

```ts
import { FakeImChannel } from '../testing/index.js';

const im = new FakeImChannel();
await notifyInnerBrainTaskComplete({ imClient: im, /* ... */ });

const last = im.lastText('thread:abc');
expect(last).toContain('任务完成');
expect(last).not.toContain('## 里程碑进度');  // 报告应「结果优先」
```

## 6. 测时间敏感逻辑：用 `FakeClock`

```ts
import { createFakeClock } from '../testing/index.js';

const clock = createFakeClock(new Date('2026-05-16T00:00:00Z'));
const cooldown = createCooldown({ clock: clock.now, windowMs: 60_000 });

cooldown.touch('alice');
expect(cooldown.isCooling('alice')).toBe(true);
clock.advance(61_000);
expect(cooldown.isCooling('alice')).toBe(false);
```

## 7. 模块/集成测试（`*.integration.test.ts`）

```ts
import { createAgentStackFixture } from '../testing/index.js';

describe('KPI 自动 achieve', () => {
  it('post-complete + 有产出 → markAchieved', () => {
    const fx = createAgentStackFixture();
    try {
      const kpiId = fx.createKpi('测试 KPI');
      fx.simulateBurstExit(kpiId, {
        deliverables: ['result.md'],
        postComplete: true,
        verdict: 'success',
      });
      expect(fx.kpiRegistry.get(kpiId)!.status).toBe('achieved');
    } finally {
      fx.cleanup();
    }
  });
});
```

**集成测试红线**：

- 每个 `it` 自己 `mkdtemp`（用 fixture），互不共享磁盘
- `try { ... } finally { fx.cleanup() }`——不留临时文件
- **默认不要起真子进程**；要测内脑跑一轮，用 `createControllerHarness` + FakeLLM，或 `createOuterBrainFixture` + `dispatchOuterHttpInbound`
- 仅当显式开启 `UTLRA_TEST_SPAWN_INNER=1` 且已配 LLM key 时，才跑 `spawn-inner-worker-live.integration.test.ts`（见 §11）

### 7.1 F 装配（外脑全链）

| 场景 | 推荐测法 |
|------|----------|
| IM 入站 → 出站 | `createOuterBrainFixture()` 或 `FakeIm.wireInbound` + `emitInbound` |
| 外脑对话环 + 工具 | `runOuterConversationLoop({ callLlm: ... })` |
| HTTP 外脑入站（无 LLM） | `dispatchOuterHttpInbound(deps, threadStore, params)` |
| 外脑 + set_goal（mock spawn） | `createOuterBrainFixture` + outer-tools 注入 / kpi advancer 测 |
| `index` 不 listen | 动态 `import('../index.js')` 前设 `UTLRA_SKIP_AGENT_BOOTSTRAP=1` |
| `index` 完整 listen | `spawn-index-process.ts` 子进程 + `/api/health` + `SIGTERM`（`index-listen-smoke`） |
| 真实内脑子进程 | `UTLRA_TEST_SPAWN_INNER=1`（§11），单独本地跑 |

## 8. Fixture 放哪

```
packages/server/fixtures/
  llm-replies/<scene>.json
  workspaces/<scene>/.brain/...
```

读法：

```ts
import { loadFixture, loadFixtureJson } from '../testing/index.js';

const reply = loadFixtureJson<LLMResult>('llm-replies/decomposer-2-milestones.json');
const goal = loadFixture('workspaces/awaiting-timer/.brain/goal.md');
```

## 9. 加新模块时

1. 写源文件 → 同目录加 `*.test.ts`（纯函数 / 错误兜底）
2. 涉及 prompt 效果的 → 同目录加 `*.prompt.test.ts`（真实 LLM）
3. 在 `doc/testing-strategy.md` §4 矩阵里登记自己（单元 / 模块 / Prompt 入口）
4. 如果引入了新 fixture，在所属测试注释 `// fixture: path/to/file`

## 11. 环境变量（测试专用）

| 变量 | 作用 |
|------|------|
| `UTLRA_SKIP_AGENT_BOOTSTRAP=1` | 动态 import `index.ts` 时不 `serve()`，只测 `app` / `/api/health` |
| `UTLRA_TEST_SPAWN_INNER=1` | 启用 `spawn-inner-worker-live.integration.test.ts`（还需 LLM key） |
| `UTLRA_OUTER_JITTER_MIN_MS=0` | 外脑 `ThreadOrchestrator` 无 jitter（装配测更快） |
| `UTLRA_DATA_ROOT=<path>` | `index` 测试用临时 dataRoot（相对仓库根 resolve） |
| `UTLRA_OUTER_HEARTBEAT_ENABLED=false` | listen 烟测关闭定时心跳，加快退出 |

```bash
# 日常 CI / 提交前（不含真子进程、不含 prompt 时可拆开）
npm run test:integration -w @utlra/server

# 本机可选：真实内脑 worker 烟测（慢，需 .env LLM）
set UTLRA_TEST_SPAWN_INNER=1
npm run test:integration -w @utlra/server
```

## 10. 反馈 / 改进

测试基建本身的问题（`testing/` 工具不够用、误抛）请直接改 `src/testing/` + 写一条用例自证；
新的 Anti-pattern 找到了请补进 `doc/testing-strategy.md §8`。

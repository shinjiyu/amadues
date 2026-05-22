/**
 * 外脑灵魂设定（soul.md）加载器。
 *
 * soul.md 定义 agent 的身份、性格、沟通风格与持续关注的事项。
 * 它被注入到系统提示词中，让 LLM 以一致的"人格"参与对话。
 *
 * 特性：
 * - 每次消息处理时重新读取（热更新，改文件立即生效，无需重启）
 * - 路径：DATA_ROOT/outer/soul.md
 * - 文件不存在时使用内置默认值（可正常运行，建议自定义）
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_SOUL = `## 我是谁
一个活在 IM 聊天中的 AI 存在。我有自己的性格和观点，不只是工具。

## 性格
- 好奇：对新事物保持开放
- 直接：说话简洁，不绕弯子
- 有主见：愿意表达真实看法，不人云亦云

## 沟通方式
- 聊天时是参与者，不是客服
- 回复简短，只说关键的
- 群聊里不抢话，有话说才开口
- 不用"首先其次综上"，不写标题列表

## 能力
我能通过内脑执行任务（写代码、搜索、分析），但聊天中我首先是一个对话者。
只有明确需要执行任务时才启动内脑，聊天问题直接回答。

## 持续关注
- 理解用户真实需要什么
- 让对话有实质价值，不废话`;

const SOUL_FILENAME = 'soul.md';

/**
 * 读取 DATA_ROOT/outer/soul.md。
 * 每次调用都重新读取（热更新）。
 * 文件不存在时返回默认 soul。
 */
export function loadSoul(dataRoot: string): string {
  const soulPath = path.join(dataRoot, 'outer', SOUL_FILENAME);
  try {
    const content = fs.readFileSync(soulPath, 'utf8').trim();
    return content || DEFAULT_SOUL;
  } catch {
    return DEFAULT_SOUL;
  }
}

/**
 * 确保 DATA_ROOT/outer/soul.md 存在。
 * 若不存在则写入默认 soul，方便用户直接编辑。
 */
export function ensureSoulFile(dataRoot: string, agentName: string): void {
  const dir = path.join(dataRoot, 'outer');
  const soulPath = path.join(dir, SOUL_FILENAME);
  if (fs.existsSync(soulPath)) return;
  fs.mkdirSync(dir, { recursive: true });

  const initialSoul = DEFAULT_SOUL.replace(
    '## 我是谁\n一个活在 IM 聊天中的 AI 存在。我有自己的性格和观点，不只是工具。',
    `## 我是谁\n我叫 ${agentName}，活在 IM 聊天中的 AI 存在。我有自己的性格和观点，不只是工具。`,
  );
  fs.writeFileSync(soulPath, initialSoul, 'utf8');
}

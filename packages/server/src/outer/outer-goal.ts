/**
 * 外脑长期目标（goal.md）加载器。
 *
 * 长期目标定义 agent 的持续性使命：
 *   - 主动监控什么（内脑任务、对话进展）
 *   - 在什么条件下向 IM 发送消息
 *   - 长期关注的议题和方向
 *
 * 区别：
 *   - soul.md  → 身份与性格（我是谁，我怎么说话）
 *   - goal.md  → 持续性目标（我要做什么，我主动关注什么）
 *   - 内脑 goal → 具体任务（内脑当前要完成的工作）
 *
 * 特性：
 *   - 热更新：每次心跳 / 消息处理时重新读取，改文件立即生效
 *   - 路径：DATA_ROOT/outer/goal.md
 *   - 文件不存在时返回空字符串（没有长期目标也能正常运行）
 */
import fs from 'node:fs';
import path from 'node:path';

const GOAL_FILENAME = 'goal.md';

/**
 * 读取 DATA_ROOT/outer/goal.md。
 * 返回内容字符串，文件不存在时返回空字符串。
 */
export function loadOuterGoal(dataRoot: string): string {
  const goalPath = path.join(dataRoot, 'outer', GOAL_FILENAME);
  try {
    return fs.readFileSync(goalPath, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * 确保 DATA_ROOT/outer/goal.md 存在。
 * 若不存在则写入默认模板。
 */
export function ensureOuterGoalFile(dataRoot: string, agentName: string): void {
  const dir = path.join(dataRoot, 'outer');
  const goalPath = path.join(dir, GOAL_FILENAME);
  if (fs.existsSync(goalPath)) return;
  fs.mkdirSync(dir, { recursive: true });

  const defaultGoal = buildDefaultGoal(agentName);
  fs.writeFileSync(goalPath, defaultGoal, 'utf8');
}

function buildDefaultGoal(agentName: string): string {
  return `# ${agentName} 的长期目标

## 主动监控
- 若内脑有正在执行的任务，定期检查进展；若长时间（>30分钟）未推进，主动分析原因并决定是否重启或调整目标
- 若发现内脑卡在错误循环中，主动重置并上报

## 主动发送 IM 消息的条件
- 内脑任务完成时，向相关线程发送简短完成通知（仅在有实质结果时）
- 内脑遇到需要用户决策的阻塞时，主动询问
- **不要**在没有实质内容时发送消息（禁止无意义的"我在思考中"等填充消息）

## 持续关注的议题
- 保持对当前项目状态的了解，随时可以给出准确的进度信息
- 识别可以主动改进的事项，不等待用户要求

## 克制原则
- 心跳时优先观察，只在有明确必要时才行动
- 每次心跳最多做一件有意义的事

## 研究类 KPI
- 交付 = workDir 报告 + 内脑 Attributor \`write_skill\` 蒸馏；群聊只许一行摘要，禁止贴全文
`;
}

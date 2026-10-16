/** set_goal / 定时派工成功时，工具输出里会出现这些句子。 */
export const WORKER_DISPATCHED_MARKERS = [
  '已创建新内脑实例并启动任务',
  '已在既有内脑实例上续跑',
  '已向内脑派发任务',
  '已后台启动工作流',
] as const;

export function isSetGoalDispatched(output: string): boolean {
  return WORKER_DISPATCHED_MARKERS.some((m) => output.includes(m));
}

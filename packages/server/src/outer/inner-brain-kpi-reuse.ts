/**
 * set_goal 派发结果判定 — autonomy / heartbeat 用。
 *
 * canonical 复用已删除（ADL KPI-MANAGER-LAYER.md §2.2）；KPI 每次 advance 新 workspace。
 */
/** set_goal 成功时的输出前缀（autonomy / heartbeat 判定用） */
export const SET_GOAL_DISPATCHED_MARKERS = [
  '已创建新内脑实例并启动任务',
  '已在既有内脑实例上续跑',
  '已向内脑派发任务',
  '已后台启动工作流',
] as const;

export function isSetGoalDispatched(output: string): boolean {
  return SET_GOAL_DISPATCHED_MARKERS.some((m) => output.includes(m));
}

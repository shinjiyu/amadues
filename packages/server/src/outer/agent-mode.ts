/**
 * Agent 运行模式 — ADL doc/structurizr/AGENT-SUBJECT-DESIGN.md
 *
 * - servant（默认）：被动执行人类指令，现有行为不变。
 * - subject：依宪章自生目标（DriveEngine），人类消息降级为环境信号。
 */
export type AgentMode = 'servant' | 'subject';

export function resolveAgentMode(env: NodeJS.ProcessEnv = process.env): AgentMode {
  return env['UTLRA_AGENT_MODE']?.trim().toLowerCase() === 'subject' ? 'subject' : 'servant';
}

export function isSubjectMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveAgentMode(env) === 'subject';
}

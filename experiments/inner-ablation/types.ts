export type ArmId = 'dyflow' | 'single';

export const ARM_IDS: readonly ArmId[] = ['dyflow', 'single'];

export interface GradeCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface GradeResult {
  pass: boolean;
  checks: GradeCheck[];
}

/** 每次运行分配的参数（端口等），写进目标文本并交给 grader */
export interface TaskRunParams {
  port: number;
}

export interface AblationTask {
  id: string;
  /** 出处：kuroneko 生产 inner-brain 实例与一句话说明 */
  source: { instanceIds: string[]; summary: string };
  /** 绝对路径；每次运行整体复制为工作目录 */
  fixtureDir: string;
  /** 绝对路径；参考解（覆盖到 fixture 之上），只给测试用，不进工作目录 */
  referenceDir?: string;
  /** 工作目录相对路径；运行前后 hash 必须一致 */
  protectedFiles: string[];
  /**
   * 互斥组（默认 = id）：同组运行不并发。agent 常用 `pkill -f <脚本名>` 清场，
   * 起同名进程的任务并发会互相误杀。
   */
  exclusiveGroup?: string;
  goal(params: TaskRunParams): string;
  grade(workDir: string, params: TaskRunParams): Promise<GradeResult>;
  /** 参考解不止是文件时（例如要起一个脱离会话的进程）由任务自己实现；只给测试用 */
  applyReference?(workDir: string, params: TaskRunParams): Promise<void>;
  /** 判分后清理（例如杀掉 agent 留下的常驻进程） */
  cleanup?(workDir: string, params: TaskRunParams): Promise<void>;
}

export function gradeFrom(checks: GradeCheck[]): GradeResult {
  return { pass: checks.length > 0 && checks.every(c => c.ok), checks };
}

/** LLM 传输层瞬时错误（可重试 / 应标 transient，非业务永久失败） */
const TRANSIENT_LLM_PATTERN =
  /terminated|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|ECONNREFUSED|socket hang up|fetch failed|network|idle timeout|aborted|AbortError/i;

export function isTransientLlmTransportError(message: string): boolean {
  return TRANSIENT_LLM_PATTERN.test(message);
}

/** Windows STATUS_STACK_BUFFER_OVERRUN / 常见 Node 子进程崩溃码 */
export function formatInnerWorkerExitMessage(
  exitCode: number | null,
  workerError?: string | null,
): string {
  if (workerError?.trim()) return workerError.trim();
  if (exitCode == null) return '内脑子进程异常退出';
  if (exitCode === 3221226505 || exitCode === -1073740791) {
    return (
      '内脑子进程异常退出（Windows 内存/栈错误 0xC0000409）。' +
      '常见原因：同时运行多个内脑 worker 或 LLM 长连接占用过高；请避免同 KPI 并行 burst。'
    );
  }
  return `子进程退出码 ${String(exitCode)}`;
}

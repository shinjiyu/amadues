/**
 * Chat IR 内部 env 读取 helper。
 *
 * **不在公开 API 中** —— 这个文件只服务 `runtime/` 内部实现，对外不保证稳定。
 */

/**
 * Demo 式 IM 默认开启：不在磁盘种子任何身份，允许任意 `sender_sid` 首次出现时登记。
 * 主站/生产不设或为 `0` 时仍种子主助手并走原有策略。
 */
export function isImOpenDemo(): boolean {
  try {
    return process.env['UTLRA_IM_OPEN_DEMO']?.trim() === '1';
  } catch {
    return false;
  }
}

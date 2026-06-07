/**
 * 动态加载 playwright，避免未安装时启动即崩溃。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PlaywrightModule = any;

export async function loadPlaywright(): Promise<PlaywrightModule> {
  try {
    return await import('playwright');
  } catch {
    throw new Error(
      'playwright not available. Ensure playwright is installed (npm dependency in @utlra/server).',
    );
  }
}

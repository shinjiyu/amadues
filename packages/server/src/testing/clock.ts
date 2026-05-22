/**
 * 测试用可注入时钟 — 对齐 doc/testing-strategy.md §S5。
 *
 * 业务代码约定：模块工厂可选接受 `clock: Clock`，默认 `realClock`。
 * 测试里替换为 `createFakeClock(...)`，可在不动 `Date.now` 的前提下精确控制时间流。
 *
 * 故意不使用 `vi.useFakeTimers()`：那会把全局 `Date` / `setTimeout` 一并改掉，
 * 让本来不依赖时钟的代码也意外冻结；此处选择「显式注入」路径。
 */

export type Clock = () => number;

export const realClock: Clock = () => Date.now();

export interface FakeClock {
  /** 当前时间戳（ms） */
  now: Clock;
  /** 向前推 `ms` 毫秒，返回新的 now */
  advance(ms: number): number;
  /** 跳到指定时间戳（必须 >= 当前 now，避免倒流） */
  set(epochMs: number): void;
  /** 当前 ISO 8601 字符串（便于直接写 pending.execute_at） */
  iso(): string;
}

export function createFakeClock(start: number | Date = 0): FakeClock {
  let current = typeof start === 'number' ? start : start.getTime();
  return {
    now: () => current,
    advance(ms: number): number {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new Error(`[fake-clock] advance(ms) requires ms >= 0, got ${ms}`);
      }
      current += ms;
      return current;
    },
    set(epochMs: number): void {
      if (epochMs < current) {
        throw new Error(
          `[fake-clock] set(${epochMs}) would move backwards from current=${current}`,
        );
      }
      current = epochMs;
    },
    iso(): string {
      return new Date(current).toISOString();
    },
  };
}

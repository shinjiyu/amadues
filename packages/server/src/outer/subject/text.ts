export function codePoints(value: string): string[] {
  return Array.from(value);
}

export function truncateCodePoints(value: string, max: number): string {
  const points = codePoints(value);
  if (points.length <= max) return value;
  return points.slice(0, max).join('');
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

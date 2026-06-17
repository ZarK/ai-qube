export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function sumDurations(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

export function compareDuration(left: number, right: number): number {
  return clamp(left - right, -10_000, 10_000);
}

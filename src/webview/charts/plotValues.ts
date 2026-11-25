export function plotValues(values: ArrayLike<number | null | undefined>): Array<number | null> {
  // uPlot uses null for gaps; NaN poisons the shared auto-range, hiding valid series too.
  return Array.from(values, (value) => typeof value === 'number' && Number.isFinite(value) ? value : null);
}

export function formatFrequencyTick(value: number | null | undefined): string {
  // Logarithmic tick lists contain null placeholders for hidden minor ticks.
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '';
  return Number(value.toPrecision(value >= 1 ? 3 : 2)).toString();
}

// Centered moving average for the chart overlay. Gaps stay gaps: a null point stays null (never smoothed over), and
// nulls inside a window are ignored. The window shrinks at the edges of the series.
export function movingAverage(values: (number | null)[], window: number): (number | null)[] {
  const half = Math.floor(Math.max(1, window) / 2);
  return values.map((v, i) => {
    if (v == null) return null;
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(values.length - 1, i + half); j += 1) {
      const x = values[j];
      if (x != null) { sum += x; n += 1; }
    }
    return sum / n;
  });
}

/** Window size: 7 for daily points, 3 periods otherwise. */
export const maWindowFor = (daily: boolean) => (daily ? 7 : 3);

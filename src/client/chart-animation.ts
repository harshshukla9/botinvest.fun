export type ChartPoint = {
  x: number;
  y: number;
};

const CHART_SAMPLE_COUNT = 80;

function lerp(start: number, end: number, progress: number) {
  return start + (end - start) * progress;
}

function sampleNumber(values: number[], progress: number) {
  if (values.length === 1) return values[0] ?? 0;
  const position = progress * (values.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.min(values.length - 1, lowerIndex + 1);
  const localProgress = position - lowerIndex;
  return lerp(values[lowerIndex] ?? 0, values[upperIndex] ?? 0, localProgress);
}

function resamplePoints(points: ChartPoint[], count: number) {
  if (!points.length) return [];
  if (points.length === count) return points;
  if (count === 1) return [points[0] ?? { x: 50, y: 28 }];
  return Array.from({ length: count }, (_, index) => {
    const progress = index / (count - 1);
    const position = progress * (points.length - 1);
    const lowerIndex = Math.floor(position);
    const upperIndex = Math.min(points.length - 1, lowerIndex + 1);
    const localProgress = position - lowerIndex;
    const lower = points[lowerIndex] ?? points[0] ?? { x: 0, y: 28 };
    const upper = points[upperIndex] ?? lower;
    return {
      x: lerp(lower.x, upper.x, localProgress),
      y: lerp(lower.y, upper.y, localProgress)
    };
  });
}

export function chartPointsFromPrices(prices: number[]) {
  if (!prices.length) return [];
  if (prices.length === 1) return [{ x: 50, y: 28 }];

  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const spread = max - min || 1;
  return Array.from({ length: CHART_SAMPLE_COUNT }, (_, index) => {
    const progress = index / (CHART_SAMPLE_COUNT - 1);
    const price = sampleNumber(prices, progress);
    return {
      x: progress * 100,
      y: 28 - ((price - min) / spread) * 23
    };
  });
}

export function interpolateChartPoints(
  from: ChartPoint[],
  to: ChartPoint[],
  progress: number
) {
  if (!to.length) return [];
  if (!from.length) return to;
  const clampedProgress = Math.max(0, Math.min(1, progress));
  const alignedFrom = resamplePoints(from, to.length);
  return to.map((point, index) => {
    const start = alignedFrom[index] ?? point;
    return {
      x: lerp(start.x, point.x, clampedProgress),
      y: lerp(start.y, point.y, clampedProgress)
    };
  });
}

export function chartPointsAttribute(points: ChartPoint[]) {
  return points
    .map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(" ");
}

export function chartPolygonAttribute(points: ChartPoint[]) {
  const line = chartPointsAttribute(points);
  return line ? `0,32 ${line} 100,32` : "";
}

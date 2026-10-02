import { localDay, type BodyMeasurement, type MeasurementKey, type WeightReading } from './bodyProgressModel.ts';
import type { HistoryMap } from './historyMigration.ts';

export type OutlookPoint = { date: string; value: number; reps?: number };
export type OutlookEstimate = { weeks: 2 | 3 | 4; date: string; value: number; low: number; high: number };
export type ProgressProjection = {
  status: 'ready' | 'insufficient' | 'stale' | 'unstable';
  quality: 'limited' | 'noisy' | 'steadier';
  reason: string;
  points: OutlookPoint[];
  count: number;
  spanDays: number;
  latest: OutlookPoint | null;
  recentAverage: number | null;
  slopePerWeek: number | null;
  estimates: OutlookEstimate[];
};
type ProjectionKind = 'weight' | 'lift' | 'measurement';
const DAY = 86_400_000;
const settings = {
  weight: { window: 42, count: 6, span: 14, stale: 21, floor: .25, maximum: 500, readings: 'recorded days' },
  lift: { window: 84, count: 4, span: 14, stale: 28, floor: 2.5, maximum: 1000, readings: 'sessions' },
  measurement: { window: 120, count: 4, span: 21, stale: 45, floor: .5, maximum: 300, readings: 'recorded days' },
} as const;
const dayNumber = (date: string) => Date.parse(`${date}T12:00:00Z`) / DAY;
const day = (value: number) => new Date(value * DAY).toISOString().slice(0, 10);
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
function validPoint(point: OutlookPoint, maximum: number) {
  return /^\d{4}-\d{2}-\d{2}$/.test(point.date) && Number.isFinite(dayNumber(point.date))
    && day(dayNumber(point.date)) === point.date && Number.isFinite(point.value) && point.value > 0 && point.value <= maximum;
}
function numeric(value: string): number | null {
  const parsed = Number(value.trim().replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// A scenario, not a calibrated probability interval. Median pairwise slopes
// reduce the influence of one unusual observation; RMS residuals still widen
// the displayed range when readings or working sets vary. No missing days are
// added and the minimum band acknowledges measurement/load increments.
export function projectProgress(input: OutlookPoint[], kind: ProjectionKind, today = localDay()): ProgressProjection {
  const config = settings[kind], now = dayNumber(today);
  const points = input.filter(point => validPoint(point, config.maximum)
    && dayNumber(point.date) <= now && dayNumber(point.date) >= now - config.window + 1)
    .sort((a, b) => a.date.localeCompare(b.date));
  const used = kind === 'lift' ? points.slice(-256) : [...new Map(points.map(point => [point.date, point])).values()];
  const latest = used.at(-1) ?? null;
  const spanDays = latest ? dayNumber(latest.date) - dayNumber(used[0].date) : 0;
  const recent = used.slice(-3);
  const result: ProgressProjection = { status: 'insufficient', quality: 'limited', reason: '', points: used, count: used.length, spanDays, latest,
    recentAverage: recent.length ? recent.reduce((sum, point) => sum + point.value, 0) / recent.length : null,
    slopePerWeek: null, estimates: [] };
  if (used.length < config.count || spanDays < config.span) {
    result.reason = `Needs at least ${config.count} ${config.readings} spanning ${config.span} days, within the last ${config.window} days.`;
    return result;
  }
  if (latest && now - dayNumber(latest.date) > config.stale) {
    result.status = 'stale';
    result.reason = `The latest reading is more than ${config.stale} days old. A fresh reading is needed for an outlook.`;
    return result;
  }
  const first = dayNumber(used[0].date);
  const xy = used.map(point => ({ x: dayNumber(point.date) - first, y: point.value }));
  const slopes: number[] = [];
  for (let i = 0; i < xy.length; i++) for (let j = i + 1; j < xy.length; j++) if (xy[j].x > xy[i].x) slopes.push((xy[j].y - xy[i].y) / (xy[j].x - xy[i].x));
  const slope = median(slopes);
  const intercept = median(xy.map(point => point.y - slope * point.x));
  const residual = Math.sqrt(xy.reduce((sum, point) => sum + (point.y - (intercept + slope * point.x)) ** 2, 0) / xy.length);
  const scale = Math.max(config.floor, residual);
  result.quality = residual > config.floor * 2 && residual > Math.abs(slope) * spanDays * .6 ? 'noisy'
    : used.length < config.count * 2 || spanDays < config.span * 2 ? 'limited' : 'steadier';
  result.slopePerWeek = slope * 7;
  result.estimates = ([2, 3, 4] as const).map(weeks => {
    const end = now + weeks * 7;
    const value = intercept + slope * (end - first);
    const extrapolatedDays = end - dayNumber(latest!.date);
    const width = scale * (1 + extrapolatedDays / Math.max(spanDays, 1));
    return { weeks, date: day(end), value, low: Math.max(.1, value - width), high: Math.min(config.maximum, value + width) };
  });
  const observedMedian = median(used.map(point => point.value));
  if (result.estimates.some(estimate => !Number.isFinite(estimate.value) || estimate.value <= 0 || estimate.value > config.maximum
      || Math.abs(estimate.value - observedMedian) > observedMedian * .5)) {
    result.status = 'unstable'; result.estimates = [];
    result.reason = 'The recent trend extrapolates beyond a usable range. More readings are needed before showing an estimate.';
    return result;
  }
  result.status = 'ready';
  result.reason = result.quality === 'noisy' ? 'Readings vary a lot; treat this as a rough scenario.'
    : result.quality === 'limited' ? 'Enough data for a rough scenario; the history is still limited.'
      : 'A steadier recent trend; actual progress can still change.';
  return result;
}

export function projectWeight(readings: WeightReading[], today = localDay()) {
  return projectProgress(readings.map(({date, value}) => ({date, value})), 'weight', today);
}
export function liftOutlookPoints(history: HistoryMap, exercise: string): OutlookPoint[] {
  return [...new Map((history[exercise] ?? []).map(session => [session.id, session])).values()]
    .filter(session => Number.isFinite(Date.parse(session.savedAt)))
    .sort((a, b) => a.savedAt.localeCompare(b.savedAt) || a.id.localeCompare(b.id))
    .flatMap(session => {
      const sets = session.sets.map(set => ({ load: numeric(set.load), reps: numeric(set.reps) }))
        .filter((set): set is {load: number; reps: number} => set.load !== null && set.reps !== null);
      if (!sets.length) return [];
      const top = sets.reduce((a, b) => b.load > a.load || b.load === a.load && b.reps > a.reps ? b : a);
      return [{date:localDay(new Date(session.savedAt)),value:top.load,reps:top.reps}];
    });
}
export function projectLift(history: HistoryMap, exercise: string, today = localDay()) {
  return projectProgress(liftOutlookPoints(history, exercise), 'lift', today);
}
export function measurementOutlookPoints(records: BodyMeasurement[], metric: MeasurementKey): OutlookPoint[] {
  const sorted = [...records].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
  return [...new Map(sorted.filter(record => record[metric] !== undefined).map(record => [record.date, {date:record.date,value:record[metric]!}])).values()];
}
export function projectMeasurement(records: BodyMeasurement[], metric: MeasurementKey, today = localDay()) {
  return projectProgress(measurementOutlookPoints(records, metric), 'measurement', today);
}

import { localDay, MEASUREMENT_KEYS, type MeasurementKey } from './bodyProgressModel.ts';
import {
  PROJECTION_MODEL_VERSION,
  type OutlookEstimate,
  type OutlookPoint,
  type ProgressProjection,
  type ProjectionKind,
  type ProjectionParameters,
} from './projectionModel.ts';

export const FORECAST_HISTORY_SCHEMA_VERSION = 1;
export const MAX_FORECAST_HISTORY_SNAPSHOTS = 3_000;
export const MAX_FORECAST_POINTS_PER_SNAPSHOT = 256;
export const MAX_FORECAST_HISTORY_BYTES = 32 * 1024 * 1024;
export const FORECAST_HISTORY_CHANGE_EVENT = 'rolling-ppl:forecast-history-change';

export type ForecastSnapshot = {
  id: string;
  kind: ProjectionKind;
  targetId: string;
  targetLabel: string;
  unit: 'kg' | 'cm';
  issuedAt: string;
  observationCutoff: string;
  modelVersion: string;
  status: 'ready';
  quality: ProgressProjection['quality'];
  reason: string;
  points: OutlookPoint[];
  parameters: ProjectionParameters;
  estimates: OutlookEstimate[];
};

export type ForecastHistoryBackup = {
  schemaVersion: 1;
  snapshots: ForecastSnapshot[];
};

type SnapshotRequest = {
  kind: ProjectionKind;
  targetId: string;
  targetLabel?: string;
  unit: 'kg' | 'cm';
  observationCutoff: string;
  issuedAt?: string;
  projection: ProgressProjection;
};

const DB_NAME = 'rolling-ppl-forecast-history-v1';
const STORE_NAME = 'snapshots';
const DAY_MS = 86_400_000;
const MAX_VALUE_BY_KIND: Record<ProjectionKind, number> = { weight: 500, lift: 1000, measurement: 300 };
const WINDOW_BY_KIND: Record<ProjectionKind, number> = { weight: 42, lift: 84, measurement: 120 };
const COUNT_BY_KIND: Record<ProjectionKind, number> = { weight: 6, lift: 4, measurement: 4 };
const SPAN_BY_KIND: Record<ProjectionKind, number> = { weight: 14, lift: 14, measurement: 21 };
const STALE_BY_KIND: Record<ProjectionKind, number> = { weight: 21, lift: 28, measurement: 45 };
const FLOOR_BY_KIND: Record<ProjectionKind, number> = { weight: .25, lift: 2.5, measurement: .5 };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Forecast history must contain valid records.');
  return value as Record<string, unknown>;
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T12:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value);
}

function dayNumber(value: string) {
  return Date.parse(`${value}T12:00:00Z`) / DAY_MS;
}

function dayAfter(date: string, amount: number) {
  return new Date(dayNumber(date) * DAY_MS + amount * DAY_MS).toISOString().slice(0, 10);
}

function finite(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`Forecast history contains an invalid ${label}.`);
  }
  return value;
}

function targetKey(snapshot: Pick<ForecastSnapshot, 'kind' | 'targetId'>) {
  return `${snapshot.kind}:${snapshot.targetId}`;
}

function snapshotId(kind: ProjectionKind, targetId: string, cutoff: string) {
  return `${kind}|${encodeURIComponent(targetId)}|${cutoff}`;
}

function encodedSize(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function createForecastSnapshot(input: SnapshotRequest): ForecastSnapshot | null {
  const { projection, kind, targetId, observationCutoff } = input;
  if (projection.status !== 'ready' || !projection.parameters || projection.estimates.length !== 3
    || !validDate(observationCutoff) || !targetId.trim()) return null;
  const estimates = ([2, 3, 4] as const).map((weeks) => projection.estimates.find((estimate) => estimate.weeks === weeks));
  if (estimates.some((estimate) => !estimate)) return null;
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  if (!validTimestamp(issuedAt)) return null;
  const targetLabel = input.targetLabel?.trim() || targetId.trim();
  const snapshot: ForecastSnapshot = {
    id: snapshotId(kind, targetId.trim(), observationCutoff),
    kind,
    targetId: targetId.trim(),
    targetLabel: targetLabel.slice(0, 200),
    unit: input.unit,
    issuedAt: new Date(issuedAt).toISOString(),
    observationCutoff,
    modelVersion: PROJECTION_MODEL_VERSION,
    status: 'ready',
    quality: projection.quality,
    reason: projection.reason.slice(0, 500),
    points: projection.points.map((point) => ({ ...point })),
    parameters: { ...projection.parameters },
    estimates: estimates.map((estimate) => ({ ...estimate! })),
  };
  try {
    return parseSnapshot(snapshot, observationCutoff);
  } catch {
    return null;
  }
}

function parseSnapshot(value: unknown, today: string): ForecastSnapshot {
  const data = object(value);
  const kind = data.kind;
  if (kind !== 'weight' && kind !== 'lift' && kind !== 'measurement') throw new Error('Invalid forecast type.');
  if (typeof data.targetId !== 'string' || !data.targetId.trim() || data.targetId.length > 200) throw new Error('Invalid forecast target.');
  const targetId = data.targetId.trim();
  if (kind === 'weight' && targetId !== 'weight') throw new Error('Invalid weight forecast target.');
  if (kind === 'measurement' && !MEASUREMENT_KEYS.includes(targetId as MeasurementKey)) throw new Error('Invalid tape forecast target.');
  if (data.unit !== (kind === 'measurement' ? 'cm' : 'kg')) throw new Error('Invalid forecast unit.');
  if (typeof data.targetLabel !== 'string' || !data.targetLabel.trim() || data.targetLabel.length > 200) throw new Error('Invalid forecast label.');
  if (!validTimestamp(data.issuedAt) || !validDate(data.observationCutoff)) throw new Error('Invalid forecast issue date.');
  const observationCutoff = data.observationCutoff;
  if (observationCutoff > today) throw new Error('Invalid forecast issue date.');
  if (new Date(data.issuedAt).toISOString() !== data.issuedAt) throw new Error('Invalid forecast issue timestamp.');
  if (data.modelVersion !== PROJECTION_MODEL_VERSION && (typeof data.modelVersion !== 'string' || !data.modelVersion.trim() || data.modelVersion.length > 100)) throw new Error('Invalid forecast model version.');
  if (data.status !== 'ready') throw new Error('Only ready forecasts can be saved.');
  if (data.quality !== 'limited' && data.quality !== 'noisy' && data.quality !== 'steadier') throw new Error('Invalid forecast quality.');
  if (typeof data.reason !== 'string' || data.reason.length > 500) throw new Error('Invalid forecast note.');
  if (data.id !== snapshotId(kind, targetId, observationCutoff)) throw new Error('Invalid forecast snapshot ID.');

  const maximum = MAX_VALUE_BY_KIND[kind];
  if (!Array.isArray(data.points) || !data.points.length || data.points.length > MAX_FORECAST_POINTS_PER_SNAPSHOT) throw new Error('Invalid forecast points.');
  const points: OutlookPoint[] = data.points.map((raw) => {
    const point = object(raw);
    if (!validDate(point.date) || point.date > observationCutoff) throw new Error('Invalid forecast point date.');
    const parsed: OutlookPoint = { date: point.date, value: finite(point.value, 'point', Number.MIN_VALUE, maximum) };
    if (point.reps !== undefined) parsed.reps = finite(point.reps, 'reps value', Number.MIN_VALUE, 300);
    return parsed;
  });
  if (points.some((point, index) => index > 0 && point.date < points[index - 1].date)) throw new Error('Forecast points must be ordered by date.');

  const rawParameters = object(data.parameters);
  const expected: ProjectionParameters = {
    windowDays: finite(rawParameters.windowDays, 'window', 1, 365),
    minimumCount: finite(rawParameters.minimumCount, 'minimum count', 2, 30),
    minimumSpanDays: finite(rawParameters.minimumSpanDays, 'minimum span', 1, 365),
    staleDays: finite(rawParameters.staleDays, 'stale limit', 1, 365),
    maximum: finite(rawParameters.maximum, 'maximum value', 1, 2000),
    bandFloor: finite(rawParameters.bandFloor, 'band floor', Number.MIN_VALUE, 1000),
    firstDate: validDate(rawParameters.firstDate) ? rawParameters.firstDate : '',
    latestDate: validDate(rawParameters.latestDate) ? rawParameters.latestDate : '',
    intercept: finite(rawParameters.intercept, 'intercept', -2000, 2000),
    slopePerDay: finite(rawParameters.slopePerDay, 'daily slope', -1000, 1000),
    residualRms: finite(rawParameters.residualRms, 'residual', 0, 2000),
    spanDays: finite(rawParameters.spanDays, 'span', 0, 365),
    pointCount: finite(rawParameters.pointCount, 'point count', 1, MAX_FORECAST_POINTS_PER_SNAPSHOT),
  };
  if (expected.windowDays !== WINDOW_BY_KIND[kind] || expected.minimumCount !== COUNT_BY_KIND[kind]
    || expected.minimumSpanDays !== SPAN_BY_KIND[kind] || expected.staleDays !== STALE_BY_KIND[kind]
    || expected.maximum !== maximum || expected.bandFloor !== FLOOR_BY_KIND[kind]
    || !expected.firstDate || !expected.latestDate || expected.firstDate !== points[0].date
    || expected.latestDate !== points.at(-1)!.date || expected.pointCount !== points.length
    || expected.spanDays !== dayNumber(expected.latestDate) - dayNumber(expected.firstDate)
    || expected.latestDate > observationCutoff) throw new Error('Invalid forecast parameters.');

  if (!Array.isArray(data.estimates) || data.estimates.length !== 3) throw new Error('Invalid forecast estimates.');
  const estimates = data.estimates.map((raw): OutlookEstimate => {
    const estimate = object(raw);
    if (![2, 3, 4].includes(estimate.weeks as number) || !validDate(estimate.date)
      || estimate.date !== dayAfter(observationCutoff, Number(estimate.weeks) * 7)) throw new Error('Invalid forecast estimate date.');
    const value = finite(estimate.value, 'estimate', Number.MIN_VALUE, maximum);
    const low = finite(estimate.low, 'lower range', Number.MIN_VALUE, maximum);
    const high = finite(estimate.high, 'upper range', Number.MIN_VALUE, maximum);
    if (low > value || value > high) throw new Error('Invalid forecast range.');
    return { weeks: estimate.weeks as 2 | 3 | 4, date: estimate.date, value, low, high };
  }).sort((a, b) => a.weeks - b.weeks);
  if (estimates.some((estimate, index) => estimate.weeks !== index + 2)) throw new Error('Duplicate forecast horizons.');

  return {
    id: snapshotId(kind, targetId, data.observationCutoff as string), kind, targetId,
    targetLabel: data.targetLabel.trim(), unit: data.unit as 'kg' | 'cm',
    issuedAt: data.issuedAt, observationCutoff,
    modelVersion: data.modelVersion as string, status: 'ready', quality: data.quality,
    reason: data.reason, points, parameters: expected, estimates,
  };
}

export function parseForecastHistory(value: unknown, today = localDay()): ForecastHistoryBackup {
  if (typeof value === 'string') {
    if (value.length > MAX_FORECAST_HISTORY_BYTES) throw new Error('Forecast history backup exceeds the 32 MiB limit.');
    try { value = JSON.parse(value); } catch { throw new Error('Forecast history backup is not valid JSON.'); }
  }
  const data = object(value);
  if (data.schemaVersion !== FORECAST_HISTORY_SCHEMA_VERSION) throw new Error('Unsupported forecast history backup version.');
  if (!Array.isArray(data.snapshots) || data.snapshots.length > MAX_FORECAST_HISTORY_SNAPSHOTS) throw new Error('Forecast history has too many snapshots.');
  const snapshots = data.snapshots.map((snapshot) => parseSnapshot(snapshot, today));
  if (new Set(snapshots.map((snapshot) => snapshot.id)).size !== snapshots.length) throw new Error('Forecast history contains duplicate snapshot IDs.');
  const result: ForecastHistoryBackup = { schemaVersion: FORECAST_HISTORY_SCHEMA_VERSION, snapshots: snapshots.sort((a, b) => a.issuedAt.localeCompare(b.issuedAt) || a.id.localeCompare(b.id)) };
  if (encodedSize(result) > MAX_FORECAST_HISTORY_BYTES) throw new Error('Forecast history backup exceeds the 32 MiB limit.');
  return result;
}

export function mergeForecastHistory(local: ForecastHistoryBackup, incoming: ForecastHistoryBackup): ForecastHistoryBackup {
  const byId = new Map(local.snapshots.map((snapshot) => [snapshot.id, snapshot]));
  incoming.snapshots.forEach((snapshot) => { if (!byId.has(snapshot.id)) byId.set(snapshot.id, snapshot); });
  return parseForecastHistory({ schemaVersion: 1, snapshots: [...byId.values()] });
}

export function forecastPointsAfterCutoff(snapshot: ForecastSnapshot, points: OutlookPoint[]): OutlookPoint[] {
  return points.filter((point) => validDate(point.date) && point.date > snapshot.observationCutoff
    && Number.isFinite(point.value) && point.value > 0 && point.value <= MAX_VALUE_BY_KIND[snapshot.kind])
    .map((point) => ({ ...point })).sort((a, b) => a.date.localeCompare(b.date));
}

export function shouldSaveForecastSnapshot(previous: ForecastSnapshot | undefined, next: ForecastSnapshot): boolean {
  if (!previous) return true;
  if (targetKey(previous) !== targetKey(next) || next.id === previous.id || next.observationCutoff <= previous.observationCutoff) return false;
  return dayNumber(next.observationCutoff) - dayNumber(previous.observationCutoff) >= 7;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('This browser cannot save forecast history.')); return; }
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(DB_NAME, 1); }
    catch { reject(new Error('Forecast history storage could not be opened.')); return; }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        const store = request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('targetKey', 'targetKey', { unique: false });
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(new Error('Forecast history storage could not be opened.'));
    request.onblocked = () => reject(new Error('Close other app tabs and try forecast history again.'));
  });
}

function readAll(db: IDBDatabase): Promise<ForecastSnapshot[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => {
      try { resolve(parseForecastHistory({ schemaVersion: 1, snapshots: request.result }).snapshots); }
      catch (error) { reject(error); }
    };
    request.onerror = () => reject(new Error('Forecast history could not be loaded.'));
    tx.onabort = () => reject(new Error('Forecast history could not be loaded.'));
  });
}

export async function exportForecastHistory(): Promise<ForecastHistoryBackup> {
  const db = await openDatabase();
  try { return parseForecastHistory({ schemaVersion: 1, snapshots: await readAll(db) }); }
  finally { db.close(); }
}

export async function loadForecastHistory(): Promise<ForecastHistoryBackup> {
  return exportForecastHistory();
}

export async function saveForecastSnapshotIfDue(snapshot: ForecastSnapshot): Promise<boolean> {
  const candidate = parseForecastHistory({ schemaVersion: 1, snapshots: [snapshot] }, snapshot.observationCutoff).snapshots[0];
  if (candidate.observationCutoff !== localDay()) return false;
  const db = await openDatabase();
  try {
    const saved = await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll();
      let saved = false;
      request.onsuccess = () => {
        try {
          const all = parseForecastHistory({ schemaVersion: 1, snapshots: request.result }).snapshots;
          const snapshots = all.filter((item) => targetKey(item) === targetKey(candidate));
          const previous = snapshots.sort((a, b) => b.observationCutoff.localeCompare(a.observationCutoff))[0];
          if (!snapshots.some((item) => item.id === candidate.id) && shouldSaveForecastSnapshot(previous, candidate)) {
            if (all.length >= MAX_FORECAST_HISTORY_SNAPSHOTS) throw new Error('Forecast history reached its 3,000 snapshot limit. Export a complete backup before making room for new forecasts.');
            if (encodedSize({ schemaVersion: 1, snapshots: [...all, candidate] }) > MAX_FORECAST_HISTORY_BYTES) {
              throw new Error('Forecast history reached its 32 MiB limit. Export a complete backup before making room for new forecasts.');
            }
            store.add({ ...candidate, targetKey: targetKey(candidate) });
            saved = true;
          }
        } catch (error) { tx.abort(); reject(error); }
      };
      request.onerror = () => { tx.abort(); reject(new Error('Forecast history could not be checked.')); };
      tx.oncomplete = () => resolve(saved);
      tx.onerror = () => reject(new Error('Forecast history could not be saved.'));
      tx.onabort = () => reject(new Error('Forecast history could not be saved.'));
    });
    if (saved && typeof window !== 'undefined') window.dispatchEvent(new Event(FORECAST_HISTORY_CHANGE_EVENT));
    return saved;
  } finally { db.close(); }
}

export async function importForecastHistory(value: unknown): Promise<{ imported: number; total: number }> {
  const incoming = parseForecastHistory(value);
  const db = await openDatabase();
  try {
    const result = await new Promise<{ imported: number; total: number }>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll();
      let summary = { imported: 0, total: 0 };
      request.onsuccess = () => {
        try {
          const current = parseForecastHistory({ schemaVersion: 1, snapshots: request.result });
          const merged = mergeForecastHistory(current, incoming);
          const known = new Set(current.snapshots.map((snapshot) => snapshot.id));
          const additions = merged.snapshots.filter((snapshot) => !known.has(snapshot.id));
          for (const snapshot of additions) store.add({ ...snapshot, targetKey: targetKey(snapshot) });
          summary = { imported: additions.length, total: merged.snapshots.length };
        } catch (error) { tx.abort(); reject(error); }
      };
      request.onerror = () => { tx.abort(); reject(new Error('Existing forecast history could not be checked.')); };
      tx.oncomplete = () => resolve(summary);
      tx.onerror = () => reject(new Error('Forecast history could not be restored.'));
      tx.onabort = () => reject(new Error('Forecast history could not be restored.'));
    });
    if (result.imported && typeof window !== 'undefined') window.dispatchEvent(new Event(FORECAST_HISTORY_CHANGE_EVENT));
    return result;
  } finally { db.close(); }
}

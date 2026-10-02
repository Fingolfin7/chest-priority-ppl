import type { CompletedWorkout } from "./sessionModel";

export type WeighIn = { id: string; date: string; kg: number; note: string; updatedAt: string };
export const MEASUREMENT_KEYS = ["chest", "waist", "arms", "thighs"] as const;
export type MeasurementKey = typeof MEASUREMENT_KEYS[number];
export type BodyMeasurement = { id: string; date: string; note: string; updatedAt: string } & Partial<Record<MeasurementKey, number>>;
export type WeightGoal = { targets: number[]; sustainedDays: number; updatedAt: string };
export type BodyDeletion = { id: string; kind: "weight" | "measurement"; deletedAt: string };
export type BodyProgressData = { schemaVersion: 1; weighIns: WeighIn[]; measurements: BodyMeasurement[]; goal: WeightGoal; deletions: BodyDeletion[] };
export type WeightReading = { date: string; value: number; source: "weigh-in" | "workout"; id: string };
export const BODY_PROGRESS_EVENT = "rolling-ppl-body-progress-changed";
export const emptyBodyProgress = (): BodyProgressData => ({ schemaVersion: 1, weighIns: [], measurements: [], goal: { targets: [], sustainedDays: 3, updatedAt: "1970-01-01T00:00:00.000Z" }, deletions: [] });

export function localDay(value = new Date()): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}
function validDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Body progress must contain valid records.");
  return value as Record<string, unknown>;
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("Invalid body progress update date.");
  return new Date(value).toISOString();
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new Error("Invalid body progress record ID.");
  return value;
}
function readingNumber(value: unknown, label: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maximum) throw new Error(`${label} must be greater than 0 and at most ${maximum}.`);
  return value;
}
function baseRecord(value: unknown, today: string) {
  const record = object(value);
  if (!validDay(record.date) || record.date > today) throw new Error("Choose a valid date on or before today.");
  if (typeof record.note !== "string" || record.note.length > 1000) throw new Error("Keep the note under 1,000 characters.");
  return { id: identifier(record.id), date: record.date, note: record.note.trim(), updatedAt: timestamp(record.updatedAt) };
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 100_000) throw new Error("Invalid body progress records.");
  return value;
}
function unique<T extends { id: string }>(values: T[]): T[] {
  if (new Set(values.map((value) => value.id)).size !== values.length) throw new Error("Duplicate body progress record IDs.");
  return values;
}
export function parseBodyProgress(value: unknown, today = localDay()): BodyProgressData {
  const data = object(value);
  if (data.schemaVersion !== 1) throw new Error("Unsupported body progress backup version.");
  const weighIns = unique(list(data.weighIns).map((value) => ({ ...baseRecord(value, today), kg: readingNumber(object(value).kg, "Weight (kg)", 500) })));
  const measurements = unique(list(data.measurements).map((value) => {
    const record: BodyMeasurement = baseRecord(value, today);
    for (const key of MEASUREMENT_KEYS) if (object(value)[key] !== undefined) record[key] = readingNumber(object(value)[key], `${key} (cm)`, 300);
    if (!MEASUREMENT_KEYS.some((key) => record[key] !== undefined)) throw new Error("Enter at least one tape measurement.");
    return record;
  }));
  const goal = object(data.goal);
  const targets = list(goal.targets).map((value) => readingNumber(value, "Target weight (kg)", 500));
  if (targets.length > 20 || new Set(targets).size !== targets.length) throw new Error("Choose up to 20 different milestone weights.");
  if (typeof goal.sustainedDays !== "number" || !Number.isInteger(goal.sustainedDays) || goal.sustainedDays < 2 || goal.sustainedDays > 30) throw new Error("Sustained days must be a whole number from 2 to 30.");
  const deletions = list(data.deletions ?? []).map((value): BodyDeletion => {
    const item = object(value);
    if (item.kind !== "weight" && item.kind !== "measurement") throw new Error("Invalid body progress deletion.");
    return { id: identifier(item.id), kind: item.kind, deletedAt: timestamp(item.deletedAt) };
  });
  return { schemaVersion: 1, weighIns, measurements, goal: { targets: [...targets].sort((a, b) => a - b), sustainedDays: goal.sustainedDays, updatedAt: timestamp(goal.updatedAt) }, deletions };
}
export function parseBodyNumber(value: string): number {
  return value.trim() ? Number(value.trim().replace(",", ".")) : NaN;
}

// One reading per calendar day. An independent weigh-in is the deliberate daily
// reading; otherwise the latest recorded workout supplies it. No copies are saved.
export function combineWeightReadings(sessions: CompletedWorkout[], weighIns: WeighIn[]): WeightReading[] {
  const byDay = new Map<string, WeightReading>();
  for (const session of [...sessions].sort((a, b) => a.endedAt.localeCompare(b.endedAt) || a.id.localeCompare(b.id))) {
    const value = parseBodyNumber(session.bodyweight);
    if (!Number.isFinite(value) || value <= 0 || value > 500 || !Number.isFinite(Date.parse(session.endedAt))) continue;
    const date = localDay(new Date(session.endedAt));
    byDay.set(date, { date, value, source: "workout", id: session.id });
  }
  for (const item of [...weighIns].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id))) {
    byDay.set(item.date, { date: item.date, value: item.kg, source: "weigh-in", id: item.id });
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}
const calendarDayNumber = (date: string) => Date.parse(`${date}T12:00:00Z`) / 86_400_000;
export function recentWeightAverages(readings: WeightReading[], today = localDay()) {
  const end = calendarDayNumber(today);
  const average = (from: number, to: number) => {
    const values = readings.filter((reading) => {
      const day = calendarDayNumber(reading.date);
      return day >= from && day <= to;
    }).map((reading) => reading.value);
    return { count: values.length, value: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null };
  };
  return { recent: average(end - 6, end), previous: average(end - 13, end - 7) };
}
export function weightMilestones(readings: WeightReading[], goal: WeightGoal) {
  const ordered = [...readings].sort((a, b) => a.date.localeCompare(b.date));
  return goal.targets.map((target) => {
    let firstReached: string | null = null;
    let sustained: string | null = null;
    let streak = 0;
    let previous: string | null = null;
    for (const reading of ordered) {
      if (reading.value >= target) {
        firstReached ??= reading.date;
        streak = previous && calendarDayNumber(reading.date) - calendarDayNumber(previous) === 1 ? streak + 1 : 1;
        if (streak >= goal.sustainedDays) sustained ??= reading.date;
      } else streak = 0;
      previous = reading.date;
    }
    return { target, firstReached, sustained, currentStreak: streak };
  });
}
function newest<T extends { updatedAt: string }>(left: T, right: T): T {
  return left.updatedAt > right.updatedAt ? left : left.updatedAt < right.updatedAt ? right : JSON.stringify(left) >= JSON.stringify(right) ? left : right;
}
export function mergeBodyProgress(left: BodyProgressData, right: BodyProgressData): BodyProgressData {
  const deletions = new Map<string, BodyDeletion>();
  for (const deletion of [...left.deletions, ...right.deletions]) {
    const key = `${deletion.kind}:${deletion.id}`;
    if (!deletions.has(key) || deletions.get(key)!.deletedAt < deletion.deletedAt) deletions.set(key, deletion);
  }
  function records<T extends { id: string; updatedAt: string }>(a: T[], b: T[], kind: BodyDeletion["kind"]): T[] {
    const map = new Map<string, T>();
    for (const entry of [...a, ...b]) map.set(entry.id, map.has(entry.id) ? newest(map.get(entry.id)!, entry) : entry);
    return [...map.values()].filter((entry) => (deletions.get(`${kind}:${entry.id}`)?.deletedAt ?? "") < entry.updatedAt).sort((a, b) => a.id.localeCompare(b.id));
  }
  return { schemaVersion: 1, weighIns: records(left.weighIns, right.weighIns, "weight"), measurements: records(left.measurements, right.measurements, "measurement"), goal: newest(left.goal, right.goal), deletions: [...deletions.values()].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)) };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("This browser cannot store body progress. Try a browser with IndexedDB enabled.")); return; }
    const request = indexedDB.open("rolling-ppl-body-progress", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("state");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Body progress storage could not be opened."));
    request.onblocked = () => reject(new Error("Close other app tabs and try body progress again."));
  });
}
export async function exportBodyProgress(): Promise<BodyProgressData> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("state", "readonly");
      const request = tx.objectStore("state").get("progress");
      request.onsuccess = () => { try { resolve(request.result === undefined ? emptyBodyProgress() : parseBodyProgress(request.result)); } catch (error) { reject(error); } };
      request.onerror = () => reject(new Error("Body progress could not be loaded."));
      tx.onabort = () => reject(new Error("Body progress could not be loaded."));
    });
  } finally { db.close(); }
}
export async function saveBodyProgress(value: BodyProgressData): Promise<void> {
  const data = parseBodyProgress(value);
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("state", "readwrite");
      const store = tx.objectStore("state");
      const current = store.get("progress");
      current.onsuccess = () => {
        try { store.put(current.result === undefined ? data : mergeBodyProgress(parseBodyProgress(current.result), data), "progress"); }
        catch (error) { tx.abort(); reject(error); }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error("Body progress could not be saved. Check available device storage and try again."));
      tx.onabort = () => reject(new Error("Body progress was not saved. Your form is still available; try again."));
    });
  } finally { db.close(); }
  window.dispatchEvent(new Event(BODY_PROGRESS_EVENT));
}
export async function importBodyProgress(value: unknown): Promise<void> {
  const incoming = parseBodyProgress(value);
  await saveBodyProgress(incoming);
}

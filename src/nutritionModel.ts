// A deliberately low-effort food log: one record per calendar day with tap
// counters and a supplement checklist. Unlogged days have no record at all, so
// a missing day is never mistaken for a day with nothing eaten.
export const NUTRITION_COUNTERS = ["meals", "snacks", "shakes"] as const;
export type NutritionCounter = typeof NUTRITION_COUNTERS[number];
export type NutritionDay = { date: string; supplements: string[]; updatedAt: string } & Record<NutritionCounter, number>;
export type Supplement = { id: string; name: string };
export type NutritionSettings = { supplements: Supplement[]; updatedAt: string };
export type NutritionData = { schemaVersion: 1; days: NutritionDay[]; settings: NutritionSettings };

export const MAX_COUNT = 30;
export const MAX_SUPPLEMENTS = 30;
export const SUGGESTED_SUPPLEMENTS = ["Creatine", "Multivitamin", "Vitamin D", "Fish oil", "Magnesium"];
export const emptyNutrition = (): NutritionData => ({ schemaVersion: 1, days: [], settings: { supplements: [], updatedAt: "1970-01-01T00:00:00.000Z" } });
export const emptyNutritionDay = (date: string): NutritionDay => ({ date, meals: 0, snacks: 0, shakes: 0, supplements: [], updatedAt: "1970-01-01T00:00:00.000Z" });

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Nutrition must contain valid records.");
  return value as Record<string, unknown>;
}
function only(record: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error("Nutrition records cannot contain unknown fields.");
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("Invalid nutrition update date.");
  return new Date(value).toISOString();
}
function validDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 100) throw new Error("Invalid supplement ID.");
  return value;
}

export function parseNutritionDay(value: unknown): NutritionDay {
  const record = object(value);
  only(record, ["date", ...NUTRITION_COUNTERS, "supplements", "updatedAt"]);
  if (!validDay(record.date)) throw new Error("Invalid nutrition date.");
  const day = { date: record.date, supplements: [] as string[], updatedAt: timestamp(record.updatedAt) } as NutritionDay;
  for (const key of NUTRITION_COUNTERS) {
    const count = record[key];
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > MAX_COUNT) throw new Error(`Nutrition ${key} must be a whole number from 0 to ${MAX_COUNT}.`);
    day[key] = count;
  }
  if (!Array.isArray(record.supplements) || record.supplements.length > MAX_SUPPLEMENTS) throw new Error("Invalid supplements taken.");
  day.supplements = [...new Set(record.supplements.map(identifier))].sort();
  return day;
}
export function parseNutritionSettings(value: unknown): NutritionSettings {
  const record = object(value);
  only(record, ["supplements", "updatedAt"]);
  if (!Array.isArray(record.supplements) || record.supplements.length > MAX_SUPPLEMENTS) throw new Error(`Keep up to ${MAX_SUPPLEMENTS} supplements.`);
  const supplements = record.supplements.map((item): Supplement => {
    const entry = object(item);
    only(entry, ["id", "name"]);
    if (typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > 60) throw new Error("Supplement names need 1 to 60 characters.");
    return { id: identifier(entry.id), name: entry.name.trim() };
  });
  if (new Set(supplements.map((item) => item.id)).size !== supplements.length) throw new Error("Duplicate supplement IDs.");
  return { supplements, updatedAt: timestamp(record.updatedAt) };
}
export function parseNutrition(value: unknown): NutritionData {
  const data = object(value);
  if (data.schemaVersion !== 1) throw new Error("Unsupported nutrition backup version.");
  if (!Array.isArray(data.days) || data.days.length > 100_000) throw new Error("Invalid nutrition days.");
  const days = data.days.map(parseNutritionDay);
  if (new Set(days.map((day) => day.date)).size !== days.length) throw new Error("Duplicate nutrition days.");
  return { schemaVersion: 1, days: days.sort((a, b) => a.date.localeCompare(b.date)), settings: parseNutritionSettings(data.settings) };
}

// Later saves win. Equal stamps from two devices pick the same copy everywhere.
export function newerNutritionRecord<T extends { updatedAt: string }>(left: T, right: T): T {
  return left.updatedAt > right.updatedAt ? left : left.updatedAt < right.updatedAt ? right : JSON.stringify(left) >= JSON.stringify(right) ? left : right;
}
export function mergeNutrition(left: NutritionData, right: NutritionData): NutritionData {
  const days = new Map<string, NutritionDay>();
  for (const day of [...left.days, ...right.days]) days.set(day.date, days.has(day.date) ? newerNutritionRecord(days.get(day.date)!, day) : day);
  return { schemaVersion: 1, days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)), settings: newerNutritionRecord(left.settings, right.settings) };
}

// A clock behind the last saved edit must still produce a newer version.
export function nextStamp(previous: string, now = new Date()): string {
  const previousTime = Date.parse(previous);
  return new Date(Math.max(now.getTime(), Number.isFinite(previousTime) ? previousTime + 1 : 0)).toISOString();
}
export function nutritionDay(data: NutritionData | undefined, date: string): NutritionDay | undefined {
  return data?.days.find((day) => day.date === date);
}
export function updateNutritionDay(data: NutritionData | undefined, date: string, edit: (day: NutritionDay) => NutritionDay, now = new Date()): NutritionData {
  const current = data ?? emptyNutrition();
  const existing = nutritionDay(current, date) ?? emptyNutritionDay(date);
  const edited = parseNutritionDay({ ...edit(structuredClone(existing)), date, updatedAt: nextStamp(existing.updatedAt, now) });
  return { ...current, days: [...current.days.filter((day) => day.date !== date), edited].sort((a, b) => a.date.localeCompare(b.date)) };
}
export function changeCount(data: NutritionData | undefined, date: string, key: NutritionCounter, delta: number, now = new Date()): NutritionData {
  return updateNutritionDay(data, date, (day) => ({ ...day, [key]: Math.min(MAX_COUNT, Math.max(0, day[key] + delta)) }), now);
}
export function toggleSupplement(data: NutritionData | undefined, date: string, id: string, now = new Date()): NutritionData {
  return updateNutritionDay(data, date, (day) => ({ ...day, supplements: day.supplements.includes(id) ? day.supplements.filter((item) => item !== id) : [...day.supplements, id] }), now);
}
export function saveSupplements(data: NutritionData | undefined, supplements: Supplement[], now = new Date()): NutritionData {
  const current = data ?? emptyNutrition();
  return { ...current, settings: parseNutritionSettings({ supplements, updatedAt: nextStamp(current.settings.updatedAt, now) }) };
}

const dayNumber = (date: string) => Math.floor(Date.parse(`${date}T12:00:00Z`) / 86_400_000);
export function shiftDay(date: string, days: number): string {
  return new Date((dayNumber(date) + days) * 86_400_000).toISOString().slice(0, 10);
}
// A day counts as logged once anything was tapped. Averages use logged days
// only: skipping the app for a day must not read as eating nothing.
export function isLogged(day: NutritionDay | undefined): day is NutritionDay {
  return Boolean(day && (NUTRITION_COUNTERS.some((key) => day[key] > 0) || day.supplements.length));
}
export function nutritionSummary(data: NutritionData | undefined, today: string, length = 7) {
  const from = shiftDay(today, -(length - 1));
  const logged = (data?.days ?? []).filter((day) => day.date >= from && day.date <= today && isLogged(day));
  const average = (key: NutritionCounter) => logged.length ? logged.reduce((sum, day) => sum + day[key], 0) / logged.length : null;
  const known = new Set(data?.settings.supplements.map((item) => item.id));
  const taken = logged.reduce((sum, day) => sum + day.supplements.filter((id) => known.has(id)).length, 0);
  return { loggedDays: logged.length, length, meals: average("meals"), snacks: average("snacks"), shakes: average("shakes"),
    supplementRate: known.size && logged.length ? taken / (known.size * logged.length) : null };
}

// Weekly picture: logged intake beside the change in average weight. Rolling
// seven-day windows end today. A week needs at least four logged days and three
// weigh-ins (and three in the week before) before it says anything.
export const STEADY_KG = 0.2;
export type IntakeWeek = {
  start: string; end: string; loggedDays: number; meals: number | null; snacks: number | null; shakes: number | null;
  weight: number | null; change: number | null; trend: "gaining" | "steady" | "losing" | null;
};
export function weeklyIntake(data: NutritionData | undefined, readings: Array<{ date: string; value: number }>, today: string, weeks = 8): IntakeWeek[] {
  const weightAverage = (start: string, end: string) => {
    const values = readings.filter((reading) => reading.date >= start && reading.date <= end).map((reading) => reading.value);
    return values.length >= 3 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  return Array.from({ length: weeks }, (_, index) => {
    const end = shiftDay(today, -7 * index), start = shiftDay(end, -6);
    const logged = (data?.days ?? []).filter((day) => day.date >= start && day.date <= end && isLogged(day));
    const average = (key: NutritionCounter) => logged.length ? logged.reduce((sum, day) => sum + day[key], 0) / logged.length : null;
    const weight = weightAverage(start, end), before = weightAverage(shiftDay(start, -7), shiftDay(start, -1));
    const change = weight !== null && before !== null ? weight - before : null;
    const trend = change === null || logged.length < 4 ? null : change >= STEADY_KG ? "gaining" : change <= -STEADY_KG ? "losing" : "steady";
    return { start, end, loggedDays: logged.length, meals: average("meals"), snacks: average("snacks"), shakes: average("shakes"), weight, change, trend };
  });
}
// Averages the usable weeks for each trend. A group appears once it has two weeks.
export function intakeByTrend(weeks: IntakeWeek[]) {
  return (["gaining", "steady", "losing"] as const).map((trend) => {
    const group = weeks.filter((week) => week.trend === trend);
    const average = (key: NutritionCounter) => group.reduce((sum, week) => sum + (week[key] ?? 0), 0) / group.length;
    return group.length >= 2 ? { trend, weeks: group.length, meals: average("meals"), snacks: average("snacks"), shakes: average("shakes") } : null;
  }).filter((group) => group !== null);
}

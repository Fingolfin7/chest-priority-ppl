// Photo check-ins come due on a fixed schedule after the latest photo date, with
// an extra check-in when a weight milestone is sustained. Photos stay on each
// device, so these reminder preferences stay with this browser too.
export type PhotoCheckInPreferences = { intervalDays: number; skippedOn?: string; skippedMilestones: string[] };
export type PhotoCheckInDue =
  | { kind: "interval"; key: string; dueOn: string; lastPhoto: string }
  | { kind: "milestone"; key: string; target: number; sustained: string };

export const PHOTO_CHECK_IN_INTERVALS = [7, 14, 21, 28] as const;
export const PHOTO_CHECK_IN_EVENT = "rolling-ppl:photo-check-in-change";
const STORAGE_KEY = "rolling-ppl-photo-check-ins-v1";
// A milestone check-in stays open this long after the trend sustains it.
const MILESTONE_WINDOW_DAYS = 14;
const validDay = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
const dayNumber = (date: string) => Date.parse(`${date}T12:00:00Z`) / 86_400_000;
export const shiftDay = (date: string, days: number) => new Date((dayNumber(date) + days) * 86_400_000).toISOString().slice(0, 10);
export const defaultPhotoCheckInPreferences = (): PhotoCheckInPreferences => ({ intervalDays: 14, skippedMilestones: [] });

// 0 turns check-ins off; anything else unexpected falls back to the default.
export function parsePhotoCheckInPreferences(value: unknown): PhotoCheckInPreferences {
  const fallback = defaultPhotoCheckInPreferences();
  if (!value || typeof value !== "object") return fallback;
  const record = value as Record<string, unknown>;
  const intervalDays = record.intervalDays === 0 || PHOTO_CHECK_IN_INTERVALS.includes(record.intervalDays as never) ? record.intervalDays as number : fallback.intervalDays;
  const skippedMilestones = Array.isArray(record.skippedMilestones) ? record.skippedMilestones.filter((key): key is string => typeof key === "string").slice(-50) : [];
  return { intervalDays, ...(validDay(record.skippedOn) ? { skippedOn: record.skippedOn } : {}), skippedMilestones };
}

export function nextScheduledCheckIn(photoDates: string[], preferences: PhotoCheckInPreferences): string | null {
  const lastPhoto = photoDates.reduce<string | undefined>((latest, date) => !latest || date > latest ? date : latest, undefined);
  if (!preferences.intervalDays || !lastPhoto) return null;
  const anchor = preferences.skippedOn && preferences.skippedOn > lastPhoto ? preferences.skippedOn : lastPhoto;
  return shiftDay(anchor, preferences.intervalDays);
}

// A milestone check-in waits for the trend to sustain the weight, and is not
// needed when a photo already falls inside the 7-day average that sustained it.
// It takes priority over a scheduled check-in; one set of photos clears both.
export function photoCheckInDue(photoDates: string[], milestones: Array<{ target: number; sustained: string | null }>, preferences: PhotoCheckInPreferences, today: string): PhotoCheckInDue | null {
  if (!preferences.intervalDays) return null;
  const lastPhoto = photoDates.reduce<string | undefined>((latest, date) => !latest || date > latest ? date : latest, undefined);
  const milestone = milestones
    .filter((item): item is { target: number; sustained: string } => item.sustained !== null)
    .filter((item) => item.sustained <= today && item.sustained > shiftDay(today, -MILESTONE_WINDOW_DAYS))
    .filter((item) => !lastPhoto || lastPhoto < shiftDay(item.sustained, -6))
    .map((item) => ({ ...item, key: `${item.target}:${item.sustained}` }))
    .filter((item) => !preferences.skippedMilestones.includes(item.key))
    .sort((a, b) => b.sustained.localeCompare(a.sustained))[0];
  if (milestone) return { kind: "milestone", ...milestone };
  const dueOn = nextScheduledCheckIn(photoDates, preferences);
  return lastPhoto && dueOn && dueOn <= today ? { kind: "interval", key: dueOn, dueOn, lastPhoto } : null;
}

// Skipping pushes the next scheduled check-in a full interval from today.
export function skipPhotoCheckIn(preferences: PhotoCheckInPreferences, due: PhotoCheckInDue, today: string): PhotoCheckInPreferences {
  return { ...preferences, skippedOn: today, skippedMilestones: due.kind === "milestone" ? [...preferences.skippedMilestones.filter((key) => key !== due.key), due.key].slice(-50) : preferences.skippedMilestones };
}

export function readPhotoCheckInPreferences(): PhotoCheckInPreferences {
  try { return parsePhotoCheckInPreferences(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")); }
  catch { return defaultPhotoCheckInPreferences(); }
}
export function writePhotoCheckInPreferences(value: PhotoCheckInPreferences) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* The change still applies for this visit. */ }
  window.dispatchEvent(new CustomEvent(PHOTO_CHECK_IN_EVENT, { detail: value }));
}

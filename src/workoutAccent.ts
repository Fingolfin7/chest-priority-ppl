import type { WorkoutKey } from "./sessionModel.ts";

// Workouts take their colour from their position in the programme, so PPL,
// Upper/Lower, full-body and custom programmes all get distinct, stable accents
// without per-key CSS. Free sessions use the first colour after the programme's.
export const ACCENT_COUNT = 6;

export function workoutAccent(workout: WorkoutKey, sequence: WorkoutKey[] = [], free = false) {
  const index = sequence.indexOf(workout);
  const slot = free ? sequence.length : index >= 0 ? index : [...workout].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0);
  return `accent-${(slot % ACCENT_COUNT) + 1}`;
}

import type { WorkoutKey } from "./sessionModel.ts";

export type PlanExercise = {
  name: string; sets: string; reps: string; rest: string; warmup: string; cue: string;
  priority: "must" | "optional"; loadSuffix?: string;
  demos: Array<{ label: string; slug: string }>; alternatives?: string[];
};
export type PlanWorkouts = Record<WorkoutKey, { summary: string; exercises: PlanExercise[] }>;
export type TrainingPhase = {
  id: string; name: string; purpose: string; startedAt: string; workouts: PlanWorkouts;
};
export type PlanState = { currentId: string; phases: TrainingPhase[] };
export type WorkoutTraining = { phaseId: string; phaseName: string; purpose: string; exercises: PlanExercise[] };
export const PLAN_STORAGE_KEY = "rolling-ppl-plan-v1";
const keys: WorkoutKey[] = ["push", "pull", "legs"];

function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function onlyKeys(value: Record<string, unknown>, allowed: string[]) { return Object.keys(value).every((key) => allowed.includes(key)); }
function text(value: unknown, max: number, required = false): value is string { return typeof value === "string" && value.length <= max && (!required || Boolean(value.trim())); }
function range(value: unknown, max: number) {
  if (typeof value !== "string" || !/^\d{1,2}(?:\s*[–—-]\s*\d{1,2})?$/.test(value)) return false;
  const values = value.match(/\d+/g)!.map(Number);
  return values[0] > 0 && values.at(-1)! >= values[0] && values.at(-1)! <= max;
}
export function validatePlanExercises(value: unknown): asserts value is PlanExercise[] {
  if (!Array.isArray(value) || !value.length || value.length > 30) throw new Error("Each workout needs 1–30 exercises.");
  const used = new Set<string>();
  const slots = new Set<string>();
  for (const exercise of value) {
    if (!record(exercise) || !onlyKeys(exercise, ["name", "sets", "reps", "rest", "warmup", "cue", "priority", "loadSuffix", "demos", "alternatives"]) || !text(exercise.name, 120, true) || !range(exercise.sets, 12) || !range(exercise.reps, 99)
      || !text(exercise.rest, 120) || !text(exercise.warmup, 240) || !text(exercise.cue, 2000)
      || !["must", "optional"].includes(String(exercise.priority)) || (exercise.loadSuffix !== undefined && !text(exercise.loadSuffix, 40))) {
      throw new Error("Check exercise names, sets (1–12), and rep ranges (1–99).");
    }
    if (!Array.isArray(exercise.demos) || exercise.demos.length > 6 || exercise.demos.some((demo) => !record(demo) || !onlyKeys(demo, ["label", "slug"]) || !text(demo.label, 120, true) || !text(demo.slug, 120, true) || !/^[a-z0-9-]+$/.test(demo.slug))) throw new Error("Invalid exercise demonstration.");
    const names = exercise.alternatives ?? [exercise.name];
    if (!Array.isArray(names) || !names.length || names.length > 8 || names.some((name) => !text(name, 120, true))) throw new Error("Invalid exercise alternatives.");
    for (const name of names) {
      const normalized = name.trim().toLocaleLowerCase();
      if (used.has(normalized)) throw new Error("Use each exercise once per workout so its sets stay distinct.");
      used.add(normalized);
    }
    // Slot names also identify React rows and session choices.
    const slotName = exercise.name.trim().toLocaleLowerCase();
    if (slots.has(slotName)) throw new Error("Each exercise slot needs a distinct name.");
    slots.add(slotName);
  }
}
export function validateTrainingPhase(value: unknown): asserts value is TrainingPhase {
  if (!record(value) || !onlyKeys(value, ["id", "name", "purpose", "startedAt", "workouts"]) || !text(value.id, 120, true) || !text(value.name, 120, true) || !text(value.purpose, 2000)
    || !text(value.startedAt, 40, true) || !Number.isFinite(Date.parse(value.startedAt)) || !record(value.workouts) || !onlyKeys(value.workouts, keys)) throw new Error("Invalid training phase.");
  for (const key of keys) {
    const workout = value.workouts[key];
    if (!record(workout) || !onlyKeys(workout, ["summary", "exercises"]) || !text(workout.summary, 240)) throw new Error("Each phase needs Push, Pull, and Legs workouts.");
    validatePlanExercises(workout.exercises);
  }
}
export function validateWorkoutTraining(value: unknown): asserts value is WorkoutTraining {
  if (!record(value) || !onlyKeys(value, ["phaseId", "phaseName", "purpose", "exercises"]) || !text(value.phaseId, 120, true) || !text(value.phaseName, 120, true) || !text(value.purpose, 2000)) throw new Error("Invalid workout phase.");
  validatePlanExercises(value.exercises);
}
export function normalizePlanState(value: unknown): PlanState {
  if (!record(value) || !onlyKeys(value, ["currentId", "phases"]) || !text(value.currentId, 120, true) || !Array.isArray(value.phases) || !value.phases.length || value.phases.length > 500) throw new Error("Invalid saved training plan.");
  value.phases.forEach(validateTrainingPhase);
  if (new Set(value.phases.map((phase) => phase.id)).size !== value.phases.length || !value.phases.some((phase) => phase.id === value.currentId)) throw new Error("The current training phase is missing or duplicated.");
  return structuredClone(value) as PlanState;
}
export function currentPhase(state: PlanState): TrainingPhase { return state.phases.find((phase) => phase.id === state.currentId)!; }
export function mergePlanStates(existing: PlanState | undefined, imported: PlanState | undefined): PlanState | undefined {
  if (!imported) return existing;
  const incoming = normalizePlanState(imported);
  if (!existing) return incoming;
  const saved = normalizePlanState(existing);
  const phases = new Map(saved.phases.map((phase) => [phase.id, phase]));
  for (const phase of incoming.phases) {
    const previous = phases.get(phase.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(phase)) throw new Error("A phase in this backup differs from the saved phase with the same ID. Restore it in another browser to review it.");
    phases.set(phase.id, phase);
  }
  return normalizePlanState({ currentId: saved.currentId, phases: [...phases.values()] });
}
export function newPhase(state: PlanState, name: string, purpose: string, workouts: PlanWorkouts, startedAt = new Date().toISOString(), id = crypto.randomUUID()): PlanState {
  const phase = { id, name: name.trim(), purpose: purpose.trim(), startedAt, workouts: structuredClone(workouts) };
  validateTrainingPhase(phase);
  return normalizePlanState({ currentId: id, phases: [...state.phases, phase] });
}
export function trainingForWorkout(phase: TrainingPhase, workout: WorkoutKey): WorkoutTraining {
  return { phaseId: phase.id, phaseName: phase.name, purpose: phase.purpose, exercises: structuredClone(phase.workouts[workout].exercises) };
}

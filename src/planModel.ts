import { isWorkoutKey, WORKOUT_SEQUENCE, workoutLabel, nextWorkout, type WorkoutKey } from "./sessionModel.ts";

export type PlanExercise = {
  name: string; sets: string; reps: string; rest: string; warmup: string; cue: string;
  priority: "must" | "optional"; loadSuffix?: string;
  demos: Array<{ label: string; slug: string }>; alternatives?: string[];
};
export type PlanWorkouts = Record<WorkoutKey, { name?: string; summary: string; exercises: PlanExercise[] }>;
export type TrainingPhase = {
  id: string; name: string; purpose: string; startedAt: string; workouts: PlanWorkouts;
  programId?: string; programName?: string; sequence?: WorkoutKey[];
};
export type PlanState = { currentId: string; phases: TrainingPhase[] };
export type WorkoutTraining = { phaseId: string; phaseName: string; purpose: string; exercises: PlanExercise[]; programId?: string; programName?: string; workoutName?: string; sequence?: WorkoutKey[]; sessionKind?: "free" };
export const PLAN_STORAGE_KEY = "rolling-ppl-plan-v1";
export function phaseSequence(phase: TrainingPhase): WorkoutKey[] { return phase.sequence ?? WORKOUT_SEQUENCE; }
export function phaseProgramName(phase: TrainingPhase) { return phase.programName ?? "Chest-priority PPL"; }
export function phaseProgramId(phase: TrainingPhase) { return phase.programId ?? "original-ppl-program"; }
// Before phases existed, untagged PPL sessions belonged to the original plan.
// Derive this association without inventing historical prescriptions or editing logs.
export function workoutBelongsToPhase(session: { workout: WorkoutKey; training?: { phaseId: string } }, phase: TrainingPhase): boolean {
  if (session.training) return session.training.phaseId === phase.id;
  return phase.id === "original-ppl-v1" && WORKOUT_SEQUENCE.includes(session.workout);
}
function validSequence(value: unknown): value is WorkoutKey[] { return Array.isArray(value) && value.length >= 1 && value.length <= 12 && value.every(isWorkoutKey) && new Set(value).size === value.length; }

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
  if (!record(value) || !onlyKeys(value, ["id", "name", "purpose", "startedAt", "workouts", "programId", "programName", "sequence"]) || !text(value.id, 120, true) || !text(value.name, 120, true) || !text(value.purpose, 2000)
    || !text(value.startedAt, 40, true) || !Number.isFinite(Date.parse(value.startedAt)) || !record(value.workouts)
    || (value.programId !== undefined && !text(value.programId, 120, true)) || (value.programName !== undefined && !text(value.programName, 120, true))) throw new Error("Invalid training phase.");
  const sequence = value.sequence ?? WORKOUT_SEQUENCE;
  if (!validSequence(sequence) || !onlyKeys(value.workouts, sequence) || Object.keys(value.workouts).length !== sequence.length) throw new Error("A programme needs 1–12 distinct workouts in its sequence.");
  for (const key of sequence) {
    const workout = value.workouts[key];
    if (!record(workout) || !onlyKeys(workout, ["name", "summary", "exercises"]) || !text(workout.summary, 240) || (workout.name !== undefined && !text(workout.name, 120, true))) throw new Error("Each workout needs a name and exercises.");
    try { validatePlanExercises(workout.exercises); } catch (error) { throw new Error(`${workout.name ?? workoutLabel(key)}: ${error instanceof Error ? error.message : "Check the exercises."}`); }
  }
}
export function validateWorkoutTraining(value: unknown): asserts value is WorkoutTraining {
  if (!record(value) || !onlyKeys(value, ["phaseId", "phaseName", "purpose", "exercises", "programId", "programName", "workoutName", "sequence", "sessionKind"]) || !text(value.phaseId, 120, true) || !text(value.phaseName, 120, true) || !text(value.purpose, 2000)
    || (value.sessionKind !== undefined && value.sessionKind !== "free")
    || ["programId", "programName", "workoutName"].some((key) => value[key] !== undefined && !text(value[key], 120, true)) || (value.sequence !== undefined && !validSequence(value.sequence))) throw new Error("Invalid workout phase.");
  if (value.sessionKind !== "free" || !Array.isArray(value.exercises) || value.exercises.length) validatePlanExercises(value.exercises);
}
export function normalizePlanState(value: unknown): PlanState {
  if (!record(value) || !onlyKeys(value, ["currentId", "phases"]) || !text(value.currentId, 120, true) || !Array.isArray(value.phases) || !value.phases.length || value.phases.length > 500) throw new Error("Invalid saved training plan.");
  value.phases.forEach(validateTrainingPhase);
  if (new Set(value.phases.map((phase) => phase.id)).size !== value.phases.length || !value.phases.some((phase) => phase.id === value.currentId)) throw new Error("The current training phase is missing or duplicated.");
  return { currentId: value.currentId, phases: value.phases.map((phase) => ({ id: phase.id, name: phase.name, purpose: phase.purpose, startedAt: phase.startedAt, programId: phaseProgramId(phase), programName: phaseProgramName(phase), sequence: [...phaseSequence(phase)], workouts: structuredClone(phase.workouts) })) };
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
export function newPhase(state: PlanState, name: string, purpose: string, workouts: PlanWorkouts, startedAt = new Date().toISOString(), id = crypto.randomUUID(), programme?: { programId: string; programName: string; sequence: WorkoutKey[] }): PlanState {
  const current = currentPhase(state);
  const phase = { id, name: name.trim(), purpose: purpose.trim(), startedAt, workouts: structuredClone(workouts), ...(programme ?? { programId: phaseProgramId(current), programName: phaseProgramName(current), sequence: [...phaseSequence(current)] }) };
  validateTrainingPhase(phase);
  return normalizePlanState({ currentId: id, phases: [...state.phases, phase] });
}
export function trainingForWorkout(phase: TrainingPhase, workout: WorkoutKey): WorkoutTraining {
  if (!phaseSequence(phase).includes(workout)) throw new Error("This workout is not part of the current programme.");
  return { phaseId: phase.id, phaseName: phase.name, purpose: phase.purpose, programId: phaseProgramId(phase), programName: phaseProgramName(phase), workoutName: workoutLabel(workout, phase), sequence: [...phaseSequence(phase)], exercises: structuredClone(phase.workouts[workout].exercises) };
}
export function nextWorkoutForPhase(workout: WorkoutKey, training: WorkoutTraining | undefined, phase: TrainingPhase, queued?: WorkoutKey): WorkoutKey {
  const sequence = phaseSequence(phase);
  if (training?.sessionKind === "free") return queued && sequence.includes(queued) ? queued : sequence[0];
  if ((training?.programId ?? "original-ppl-program") !== phaseProgramId(phase)) return sequence[0];
  const following = nextWorkout(workout, training?.sequence ?? WORKOUT_SEQUENCE);
  return sequence.includes(following) ? following : sequence[0];
}

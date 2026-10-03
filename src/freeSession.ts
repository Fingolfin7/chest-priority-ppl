import { phaseProgramId, phaseProgramName, phaseSequence, type PlanExercise, type TrainingPhase, type WorkoutTraining } from "./planModel.ts";
import { createActiveWorkout, type ActiveWorkout } from "./sessionModel.ts";

// Concrete alternatives use the same names as programme history and progression.
export function freeSessionCatalog(phase: TrainingPhase): PlanExercise[] {
  const exercises = new Map<string, PlanExercise>();
  for (const key of phaseSequence(phase)) {
    for (const slot of phase.workouts[key].exercises) {
      for (const name of slot.alternatives ?? [slot.name]) {
        if (exercises.has(name)) continue;
        const exercise = structuredClone(slot);
        delete exercise.alternatives;
        exercises.set(name, { ...exercise, name, priority: "optional", demos: structuredClone(slot.alternatives ? slot.demos.filter((demo) => demo.label === name) : slot.demos) });
      }
    }
  }
  return [...exercises.values()];
}

export function createFreeSession(phase: TrainingPhase, startedAt?: string, id?: string): ActiveWorkout {
  // Avoid colliding with a custom programme's workout IDs.
  let key = "free-session";
  while (phase.workouts[key]) key += "-free";
  const training: WorkoutTraining = {
    sessionKind: "free", phaseId: phase.id, phaseName: phase.name, purpose: phase.purpose,
    programId: phaseProgramId(phase), programName: phaseProgramName(phase),
    workoutName: "Free session", sequence: [...phaseSequence(phase)], exercises: [],
  };
  return { ...createActiveWorkout(key, startedAt, id), training };
}

export function addFreeSessionExercise(active: ActiveWorkout, exercise: PlanExercise): ActiveWorkout {
  if (active.training?.sessionKind !== "free") throw new Error("Start a free session first.");
  if (active.training.exercises.some((item) => item.name === exercise.name) || active.training.exercises.length >= 30) return active;
  return { ...active, training: { ...active.training, exercises: [...active.training.exercises, structuredClone(exercise)] } };
}

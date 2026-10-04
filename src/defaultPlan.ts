import type { PlanExercise, PlanState, PlanWorkouts } from "./planModel.ts";
import { legacyExerciseDefinitions } from "./legacyExerciseDefinitions.ts";

function prescribe(name: string, prescription: Omit<PlanExercise, "name" | "cue" | "demos" | "loadSuffix">): PlanExercise {
  const definition = legacyExerciseDefinitions.find((exercise) => exercise.name === name)!;
  return { ...structuredClone(definition), ...prescription };
}

export const defaultWorkouts: PlanWorkouts = {
  push: { summary: "6 exercises · chest priority", exercises: [
    prescribe("Barbell bench press", {"sets":"3–4","reps":"5–8","rest":"2–4 min","warmup":"3–4 ramp sets","priority":"must"}),
    prescribe("Incline dumbbell bench press", {"sets":"3","reps":"6–10","rest":"2–3 min","warmup":"1–2 ramp sets × 6–8","priority":"must"}),
    prescribe("Lateral raise", {"sets":"2–3","reps":"12–20","rest":"60–90 sec","warmup":"1 light set × 15–20","priority":"must"}),
    prescribe("Cable triceps pushdown", {"sets":"3","reps":"8–12","rest":"60–90 sec","warmup":"1 light set × 12–15","priority":"must"}),
    prescribe("Overhead dumbbell triceps extension", {"sets":"2–3","reps":"10–15","rest":"60–90 sec","warmup":"1 light set × 12–15","priority":"optional"}),
    prescribe("Chest press machine", {"sets":"2","reps":"8–12","rest":"90–120 sec","warmup":"1 light ramp set × 8–10","priority":"optional"}),
  ] },
  pull: { summary: "5 exercises · back + biceps", exercises: [
    prescribe("Bent-over barbell row", {"sets":"3","reps":"6–10","rest":"2–3 min","warmup":"2–3 ramp sets × 5–8","priority":"must"}),
    {"name":"Vertical pull","alternatives":["Lat pulldown","Pull-ups"],"sets":"3","reps":"6–12","rest":"2–3 min","warmup":"1 light or assisted set × 8–10","cue":"Start by bringing your shoulders down, then pull your elbows toward your ribs without swinging.","priority":"must","demos":[{"label":"Lat pulldown","slug":"lat-pulldown"},{"label":"Pull-ups","slug":"pullups"}]},
    prescribe("Rear-delt fly", {"sets":"2–3","reps":"12–20","rest":"60–90 sec","warmup":"1 light set × 15–20","priority":"must"}),
    prescribe("Barbell curl", {"sets":"3","reps":"8–12","rest":"60–90 sec","warmup":"1 light set × 10–12","priority":"must"}),
    prescribe("Dumbbell hammer curl", {"sets":"2–3","reps":"8–12","rest":"60–90 sec","warmup":"1 light set × 10–12","priority":"optional"}),
  ] },
  legs: { summary: "6 exercises · squat + hinge", exercises: [
    prescribe("Back squat", {"sets":"3","reps":"5–8","rest":"3–5 min","warmup":"3–4 ramp sets","priority":"must"}),
    prescribe("Conventional deadlift", {"sets":"2","reps":"4–6","rest":"3–5 min","warmup":"2–3 ramp sets × 3–5","priority":"must"}),
    prescribe("Leg curl", {"sets":"3","reps":"10–15","rest":"60–90 sec","warmup":"1 light set × 12–15","priority":"must"}),
    {"name":"Quad accessory","alternatives":["Leg Extensions","Bulgarian split squat"],"sets":"2–3","reps":"8–12","rest":"2–3 min","warmup":"1–2 light sets × 8","cue":"Choose the option you can control through a comfortable range. Move smoothly without swinging or bouncing.","priority":"optional","demos":[{"label":"Leg Extensions","slug":"db-leg-extensions"},{"label":"Bulgarian split squat","slug":"split-squat"}]},
    prescribe("Calf raise", {"sets":"2–3","reps":"10–15","rest":"60–90 sec","warmup":"1 easy set × 12–15","priority":"optional"}),
    prescribe("Ab crunch machine", {"sets":"2–3","reps":"10–15","rest":"60–90 sec","warmup":"1 light set × 12–15","priority":"optional"}),
  ] },
};

export function defaultPlanState(): PlanState { return { currentId: "original-ppl-v1", phases: [{ id: "original-ppl-v1", name: "Chest emphasis", purpose: "Build strength and muscle with a rolling Push, Pull, Legs sequence.", startedAt: "2026-10-02T00:00:00.000Z", programId: "original-ppl-program", programName: "Chest-priority PPL", sequence: ["push", "pull", "legs"], workouts: structuredClone(defaultWorkouts) }] }; }

export type ProgramPreset = "ppl" | "upper-lower" | "full-body" | "custom";
export function programPreset(preset: ProgramPreset): { name: string; sequence: string[]; workouts: PlanWorkouts } {
  if (preset === "ppl") return { name: "Chest-priority PPL", sequence: ["push", "pull", "legs"], workouts: structuredClone(defaultWorkouts) };
  const pick = (...names: string[]) => names.map((name) => structuredClone(Object.values(defaultWorkouts).flatMap((workout) => workout.exercises).find((exercise) => exercise.name === name)!));
  if (preset === "upper-lower") return { name: "Upper / Lower", sequence: ["upper", "lower"], workouts: {
    upper: { name: "Upper", summary: "Press, pull, shoulders and arms", exercises: pick("Barbell bench press", "Bent-over barbell row", "Vertical pull", "Lateral raise", "Cable triceps pushdown", "Barbell curl") },
    lower: { name: "Lower", summary: "Squat, hinge and legs", exercises: pick("Back squat", "Conventional deadlift", "Leg curl", "Calf raise", "Ab crunch machine") },
  } };
  if (preset === "full-body") return { name: "Full body", sequence: ["full-body"], workouts: {
    "full-body": { name: "Full body", summary: "Squat, press and pull", exercises: pick("Back squat", "Barbell bench press", "Bent-over barbell row", "Leg curl", "Lateral raise") },
  } };
  return { name: "My programme", sequence: ["workout-a"], workouts: { "workout-a": { name: "Workout A", summary: "", exercises: [{ name: "", sets: "3", reps: "8–12", rest: "", warmup: "", cue: "", priority: "must", demos: [] }] } } };
}

import { exerciseDefinitions, EXERCISE_DB_REVISION, type ExerciseDefinition } from "./data/exercises.ts";
import { legacyExerciseDefinitions } from "./legacyExerciseDefinitions.ts";
import type { PlanExercise } from "./planModel.ts";

// These aliases keep existing histories, drafts and checkpoints on their original names.
const legacySourceIds: Record<string, string> = {
  "Barbell bench press": "Barbell_Bench_Press_-_Medium_Grip",
  "Incline dumbbell bench press": "Incline_Dumbbell_Press",
  "Lateral raise": "Side_Lateral_Raise",
  "Cable triceps pushdown": "Triceps_Pushdown",
  "Overhead dumbbell triceps extension": "Standing_Dumbbell_Triceps_Extension",
  "Chest press machine": "Leverage_Chest_Press",
  "Bent-over barbell row": "Bent_Over_Barbell_Row",
  "Lat pulldown": "Wide-Grip_Lat_Pulldown",
  "Pull-ups": "Pullups",
  "Rear-delt fly": "Cable_Rear_Delt_Fly",
  "Barbell curl": "Barbell_Curl",
  "Dumbbell hammer curl": "Hammer_Curls",
  "Back squat": "Barbell_Squat",
  "Conventional deadlift": "Barbell_Deadlift",
  "Leg curl": "Lying_Leg_Curls",
  "Leg press": "Leg_Press",
  "Bulgarian split squat": "Split_Squat_with_Dumbbells",
  "Calf raise": "Smith_Machine_Calf_Raise",
  "Ab crunch machine": "Ab_Crunch_Machine",
};
export const normalizeExerciseSearch = (name: string) => name.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export const libraryDemoSlug = (id: string) => `db-${id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
const bySlug = new Map(exerciseDefinitions.map((definition) => [libraryDemoSlug(definition.id), definition]));
const legacyById = new Map(Object.entries(legacySourceIds).map(([name, id]) => [id, legacyExerciseDefinitions.find((definition) => definition.name === name)!]));
const searchAliases: Record<string, string[]> = {
  Romanian_Deadlift: ["rdl"],
  Pushups: ["push up", "push ups", "press up", "press ups"],
  Standing_Military_Press: ["overhead press", "ohp"],
  Dumbbell_Bench_Press: ["db bench press", "flat dumbbell press"],
};
const definitionsByName = new Map<string, ExerciseDefinition>();
for (const definition of exerciseDefinitions) {
  definitionsByName.set(normalizeExerciseSearch(definition.name), definition);
  const legacy = legacyById.get(definition.id);
  if (legacy) definitionsByName.set(normalizeExerciseSearch(legacy.name), definition);
  for (const alias of searchAliases[definition.id] ?? []) definitionsByName.set(normalizeExerciseSearch(alias), definition);
}
export function exerciseDefinition(name: string) { return definitionsByName.get(normalizeExerciseSearch(name)); }

// Definitions contain identity/instructions/images. The logger still receives a
// prescription snapshot, keeping old backup and device-sync schemas compatible.
export function exerciseFromDefinition(definition: ExerciseDefinition): PlanExercise {
  const legacy = legacyById.get(definition.id);
  return {
    name: legacy?.name ?? definition.name, sets: "3", reps: "8–12", rest: "90 sec", warmup: "", priority: "must",
    cue: legacy?.cue ?? definition.instructions.join("\n").slice(0, 2000),
    demos: legacy ? structuredClone(legacy.demos) : [{ label: definition.name, slug: libraryDemoSlug(definition.id) }],
    ...(legacy?.loadSuffix ? { loadSuffix: legacy.loadSuffix } : {}),
  };
}
export const libraryExercises = exerciseDefinitions.map(exerciseFromDefinition);

export function concreteExercises(slots: PlanExercise[]): PlanExercise[] {
  return slots.flatMap((slot) => (slot.alternatives ?? [slot.name]).map((name) => {
    const exercise = structuredClone(slot);
    delete exercise.alternatives;
    return { ...exercise, name, demos: slot.alternatives ? exercise.demos.filter((demo) => demo.label === name) : exercise.demos };
  }));
}
export function exerciseCatalog(saved: PlanExercise[] = []): PlanExercise[] {
  const catalog = new Map(libraryExercises.map((exercise) => [normalizeExerciseSearch(exercise.name), structuredClone(exercise)]));
  const remembered = new Set<string>();
  for (const exercise of concreteExercises(saved)) {
    if (exercise.name.trim()) { const key = normalizeExerciseSearch(exercise.name); catalog.set(key, exercise); remembered.add(key); }
  }
  return [...catalog.values()].sort((a, b) => Number(remembered.has(normalizeExerciseSearch(b.name))) - Number(remembered.has(normalizeExerciseSearch(a.name))));
}
export function rememberedExercises(phases: Array<{ workouts: Record<string, { exercises: PlanExercise[] }> }>, sessions: Array<{ training?: { exercises: PlanExercise[] }; exercises: Array<{ name: string; priority: "must" | "optional"; loadSuffix?: string }> }>, active: PlanExercise[] = []): PlanExercise[] {
  const logged = [...sessions].reverse().flatMap((session) => session.training?.exercises ?? session.exercises.map((exercise) => {
    const definition = exerciseDefinition(exercise.name);
    return { ...(definition ? exerciseFromDefinition(definition) : { sets: "3", reps: "8–12", rest: "90 sec", warmup: "", cue: "", demos: [] }), name: exercise.name, priority: exercise.priority, loadSuffix: exercise.loadSuffix };
  }));
  return [...logged, ...phases.flatMap((phase) => Object.values(phase.workouts).flatMap((workout) => workout.exercises)), ...active];
}
export function searchExercises(catalog: PlanExercise[], query: string, muscle = "", equipment = ""): PlanExercise[] {
  const words = normalizeExerciseSearch(query).split(" ").filter(Boolean);
  return catalog.filter((exercise) => {
    const definition = exerciseDefinition(exercise.name);
    if (muscle && !definition?.primaryMuscles.includes(muscle) && !definition?.secondaryMuscles.includes(muscle)) return false;
    if (equipment && definition?.equipment !== equipment) return false;
    const searchable = normalizeExerciseSearch([exercise.name, definition?.name ?? "", ...(searchAliases[definition?.id ?? ""] ?? []), ...(definition?.primaryMuscles ?? []), ...(definition?.secondaryMuscles ?? []), definition?.equipment ?? ""].join(" "));
    return words.every((word) => searchable.split(" ").some((token) => token.startsWith(word)));
  }).sort((a, b) => {
    const queryName = normalizeExerciseSearch(query);
    return Number(normalizeExerciseSearch(b.name) === queryName) - Number(normalizeExerciseSearch(a.name) === queryName);
  });
}
export const muscleOptions = [...new Set(exerciseDefinitions.flatMap((definition) => [...definition.primaryMuscles, ...definition.secondaryMuscles]))].sort();
export const equipmentOptions = [...new Set(exerciseDefinitions.map((definition) => definition.equipment))].sort();
export const EXERCISE_IMAGE_BASE = `https://raw.githubusercontent.com/yuhonas/free-exercise-db/${EXERCISE_DB_REVISION}/exercises/`;
export function exerciseImageSources(slug: string): string[] {
  const definition = bySlug.get(slug);
  if (definition) return definition.images.slice(0, 2).map((path) => `${EXERCISE_IMAGE_BASE}${path.split("/").map(encodeURIComponent).join("/")}`);
  return slug.startsWith("db-") ? [] : [`./exercises/${slug}-0.jpg`, `./exercises/${slug}-1.jpg`];
}

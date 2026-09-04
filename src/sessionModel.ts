import type { HistoryMap, SetEntry } from "./historyMigration";

export type WorkoutKey = "push" | "pull" | "legs";
export type ExercisePriority = "must" | "optional";

export type ActiveWorkout = {
  id: string;
  workout: WorkoutKey;
  startedAt: string;
};

export type CompletedExercise = {
  name: string;
  priority: ExercisePriority;
  loadSuffix?: string;
  sets: SetEntry[];
};

export type WorkoutSync = {
  status: "unsynced" | "syncing" | "synced" | "error" | "legacy";
  message?: string;
  projectId?: number;
  projectName?: string;
  autumnSessionId?: number;
  syncedAt?: string;
};

export type CompletedWorkout = {
  id: string;
  workout: WorkoutKey;
  startedAt: string;
  endedAt: string;
  bodyweight: string;
  note: string;
  exercises: CompletedExercise[];
  sync: WorkoutSync;
};

export type ExerciseDefinition = {
  name: string;
  priority: ExercisePriority;
  loadSuffix?: string;
};

export const WORKOUT_SEQUENCE: WorkoutKey[] = ["push", "pull", "legs"];

export function nextWorkout(workout: WorkoutKey): WorkoutKey {
  const index = WORKOUT_SEQUENCE.indexOf(workout);
  return WORKOUT_SEQUENCE[(index + 1) % WORKOUT_SEQUENCE.length];
}

export function createActiveWorkout(workout: WorkoutKey, startedAt = new Date().toISOString(), id = crypto.randomUUID()): ActiveWorkout {
  return { id, workout, startedAt };
}

export function selectedExerciseSets(entries: SetEntry[]) {
  let lastUsed = -1;
  entries.forEach((entry, index) => {
    if (entry.load.trim() || entry.reps.trim()) lastUsed = index;
  });
  if (lastUsed < 0) return { sets: [] as SetEntry[], error: "" };

  const sets = entries.slice(0, lastUsed + 1).map((entry) => ({
    ...(entry.id ? { id: entry.id } : {}),
    load: entry.load.trim(),
    reps: entry.reps.trim(),
  }));
  if (sets.some((entry) => !entry.reps || !Number.isFinite(Number(entry.reps)) || Number(entry.reps) <= 0)) {
    return { sets: [] as SetEntry[], error: "Every entered set needs a valid rep count." };
  }
  return { sets, error: "" };
}

export function completeWorkout({
  active,
  definitions,
  drafts,
  bodyweight,
  note,
  endedAt = new Date().toISOString(),
}: {
  active: ActiveWorkout;
  definitions: ExerciseDefinition[];
  drafts: Record<string, SetEntry[]>;
  bodyweight: string;
  note: string;
  endedAt?: string;
}): { session?: CompletedWorkout; error?: string } {
  const trimmedBodyweight = bodyweight.trim();
  if (trimmedBodyweight && (!Number.isFinite(Number(trimmedBodyweight)) || Number(trimmedBodyweight) <= 0)) {
    return { error: "Bodyweight must be a positive number or left blank." };
  }
  if (Date.parse(endedAt) < Date.parse(active.startedAt)) {
    return { error: "The workout end time cannot be before its start time." };
  }

  const exercises: CompletedExercise[] = [];
  for (const definition of definitions) {
    const result = selectedExerciseSets(drafts[definition.name] ?? []);
    if (result.error) return { error: `${definition.name}: ${result.error}` };
    if (result.sets.length) exercises.push({ ...definition, sets: result.sets });
  }
  if (!exercises.length) return { error: "Log at least one work set before finishing." };

  return {
    session: {
      id: active.id,
      workout: active.workout,
      startedAt: active.startedAt,
      endedAt,
      bodyweight: trimmedBodyweight,
      note: note.trim(),
      exercises,
      sync: { status: "unsynced" },
    },
  };
}

export function addWorkoutToHistory(history: HistoryMap, session: CompletedWorkout): HistoryMap {
  const next: HistoryMap = { ...history };
  session.exercises.forEach((exercise) => {
    const saved = {
      id: `${session.id}:${exercise.name}`,
      savedAt: session.endedAt,
      sets: exercise.sets,
    };
    const existing = (next[exercise.name] ?? []).filter((item) => item.id !== saved.id);
    next[exercise.name] = [saved, ...existing].sort((left, right) => right.savedAt.localeCompare(left.savedAt));
  });
  return next;
}

function displayLoad(load: string, suffix = "") {
  const value = load.trim();
  if (!value || value.toLowerCase() === "bw") return "BW";
  if (/^-?\d+(?:[.,]\d+)?$/.test(value)) return `${value.replace(",", ".")} kg${suffix}`;
  return value;
}

export function formatExerciseSets(exercise: CompletedExercise) {
  const groups: Array<{ load: string; reps: string[] }> = [];
  exercise.sets.forEach((set) => {
    const load = displayLoad(set.load, exercise.loadSuffix);
    const last = groups.at(-1);
    if (last?.load === load) last.reps.push(set.reps);
    else groups.push({ load, reps: [set.reps] });
  });
  return groups.map((group) => `${group.load} × ${group.reps.join(", ")}`).join("; ");
}

export function workoutSummary(session: CompletedWorkout) {
  const lines = [
    `${session.workout[0].toUpperCase()}${session.workout.slice(1)} day.`,
    "",
    ...session.exercises.map((exercise) => `${exercise.name}: ${formatExerciseSets(exercise)}`),
  ];
  if (session.bodyweight) lines.push("", `Bodyweight: ${session.bodyweight} kg.`);
  if (session.note) lines.push("", session.note);
  return lines.join("\n");
}

export function workoutDurationMinutes(session: Pick<CompletedWorkout, "startedAt" | "endedAt">) {
  return Math.max(0, Math.round((Date.parse(session.endedAt) - Date.parse(session.startedAt)) / 60_000));
}

export function elapsedLabel(startedAt: string, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function sessionsInLastDays(sessions: CompletedWorkout[], days: number, now = Date.now()) {
  const threshold = now - days * 86_400_000;
  return sessions.filter((session) => Date.parse(session.endedAt) >= threshold);
}

export type LiftMilestone = {
  exercise: string;
  date: string;
  kind: "load" | "reps";
  load: string;
  reps: string;
};

export function liftMilestones(history: HistoryMap): LiftMilestone[] {
  const milestones: LiftMilestone[] = [];
  Object.entries(history).forEach(([exercise, sessions]) => {
    let seen = false;
    let bestNumericLoad = -Infinity;
    const bestRepsByLoad = new Map<string, number>();
    [...sessions].sort((left, right) => left.savedAt.localeCompare(right.savedAt)).forEach((session) => {
      const candidates = session.sets.map((set) => ({ ...set, numericLoad: Number(set.load) }))
        .sort((left, right) => {
          const leftLoad = Number.isFinite(left.numericLoad) ? left.numericLoad : -Infinity;
          const rightLoad = Number.isFinite(right.numericLoad) ? right.numericLoad : -Infinity;
          return rightLoad - leftLoad || Number(right.reps) - Number(left.reps);
        });
      const best = candidates[0];
      if (!best) return;
      const numeric = Number.isFinite(best.numericLoad) && best.numericLoad > 0;
      const loadKey = numeric ? String(best.numericLoad) : (best.load.trim().toLowerCase() || "bw");
      const reps = Number(best.reps);
      const previousReps = bestRepsByLoad.get(loadKey) ?? -Infinity;
      if (seen && numeric && best.numericLoad > bestNumericLoad) milestones.push({ exercise, date: session.savedAt, kind: "load", load: best.load, reps: best.reps });
      else if (seen && reps > previousReps) milestones.push({ exercise, date: session.savedAt, kind: "reps", load: best.load || "BW", reps: best.reps });
      if (numeric) bestNumericLoad = Math.max(bestNumericLoad, best.numericLoad);
      bestRepsByLoad.set(loadKey, Math.max(previousReps, reps));
      seen = true;
    });
  });
  return milestones.sort((left, right) => right.date.localeCompare(left.date));
}

export function migrateLegacyHistory(history: HistoryMap, exerciseWorkouts: Record<string, WorkoutKey>): CompletedWorkout[] {
  const grouped = new Map<string, CompletedWorkout>();
  Object.entries(history).forEach(([name, savedSessions]) => {
    const workout = exerciseWorkouts[name];
    if (!workout) return;
    savedSessions.forEach((saved) => {
      const date = saved.savedAt.slice(0, 10);
      const key = `${date}:${workout}`;
      const existing = grouped.get(key) ?? {
        id: `legacy-${key}`,
        workout,
        startedAt: saved.savedAt,
        endedAt: saved.savedAt,
        bodyweight: "",
        note: "",
        exercises: [],
        sync: { status: "legacy" as const },
      };
      existing.startedAt = existing.startedAt < saved.savedAt ? existing.startedAt : saved.savedAt;
      existing.endedAt = existing.endedAt > saved.savedAt ? existing.endedAt : saved.savedAt;
      if (!existing.exercises.some((exercise) => exercise.name === name)) {
        existing.exercises.push({ name, priority: "must", sets: saved.sets });
      }
      grouped.set(key, existing);
    });
  });
  return Array.from(grouped.values()).sort((left, right) => right.endedAt.localeCompare(left.endedAt));
}

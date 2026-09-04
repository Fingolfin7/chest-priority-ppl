import { canonicalExerciseName, type HistoryMap, type SetEntry } from "./historyMigration.ts";
import type { CompletedExercise, CompletedWorkout, WorkoutKey, WorkoutSync } from "./sessionModel";

export type ExportSession = {
  exercise: string;
  sessionId: string;
  performedAt: string;
  sets: Array<SetEntry & { set: number }>;
};

export type ParsedBackup = {
  sessions: ExportSession[];
  workouts: CompletedWorkout[];
};

const WORKOUT_KEYS: WorkoutKey[] = ["push", "pull", "legs"];
const SYNC_STATUSES: WorkoutSync["status"][] = ["unsynced", "syncing", "synced", "error", "legacy"];
const CSV_HEADERS = [
  "exercise", "session_date", "session_timestamp", "session_id", "set_number", "load", "reps",
  "workout_id", "workout", "workout_started_at", "workout_ended_at", "bodyweight", "session_note",
  "exercise_priority", "load_suffix",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkoutKey(value: unknown): value is WorkoutKey {
  return typeof value === "string" && WORKOUT_KEYS.includes(value as WorkoutKey);
}

function normalizeBodyweight(value: unknown, context: string) {
  if (value == null || String(value).trim() === "") return "";
  const normalized = String(value).trim().replace(",", ".");
  if (!Number.isFinite(Number(normalized)) || Number(normalized) <= 0) throw new Error(`${context} has an invalid bodyweight.`);
  return normalized;
}

function normalizeSets(value: unknown, context: string) {
  if (!Array.isArray(value) || !value.length) throw new Error(`${context} has no work sets.`);
  return value.map((rawSet, index) => {
    if (!isRecord(rawSet)) throw new Error(`${context}, set ${index + 1} is invalid.`);
    const load = rawSet.load == null ? "" : String(rawSet.load).trim();
    const reps = rawSet.reps == null ? "" : String(rawSet.reps).trim();
    const set = Number(rawSet.set ?? index + 1);
    if (!Number.isInteger(set) || set < 1 || !reps || !Number.isFinite(Number(reps)) || Number(reps) <= 0) throw new Error(`${context}, set ${index + 1} is invalid.`);
    return { ...(typeof rawSet.id === "string" && rawSet.id ? { id: rawSet.id } : {}), set, load, reps };
  }).sort((left, right) => left.set - right.set);
}

export function exportSessions(history: HistoryMap): ExportSession[] {
  return Object.entries(history).flatMap(([exercise, sessions]) => sessions.map((session) => ({
    exercise,
    sessionId: session.id,
    performedAt: session.savedAt,
    sets: session.sets.map((set, index) => ({ set: index + 1, ...set })),
  }))).sort((left, right) => right.performedAt.localeCompare(left.performedAt));
}

export function normalizeSession(value: unknown, position: number): ExportSession {
  if (!isRecord(value)) throw new Error(`Session ${position} is not an object.`);
  const exercise = typeof value.exercise === "string" ? canonicalExerciseName(value.exercise) : "";
  const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
  const performedAt = typeof value.performedAt === "string" ? value.performedAt.trim() : "";
  if (!exercise || !sessionId) throw new Error(`Session ${position} is missing an exercise or session ID.`);
  if (!performedAt || Number.isNaN(Date.parse(performedAt))) throw new Error(`Session ${position} has an invalid timestamp.`);
  return { exercise, sessionId, performedAt: new Date(performedAt).toISOString(), sets: normalizeSets(value.sets, `Session ${position}`) };
}

function normalizeWorkout(value: unknown, position: number): CompletedWorkout {
  if (!isRecord(value)) throw new Error(`Workout ${position} is not an object.`);
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const startedAt = typeof value.startedAt === "string" ? value.startedAt.trim() : "";
  const endedAt = typeof value.endedAt === "string" ? value.endedAt.trim() : "";
  if (!id || !isWorkoutKey(value.workout)) throw new Error(`Workout ${position} is missing an ID or workout type.`);
  if (!startedAt || !endedAt || Number.isNaN(Date.parse(startedAt)) || Number.isNaN(Date.parse(endedAt)) || Date.parse(endedAt) < Date.parse(startedAt)) throw new Error(`Workout ${position} has invalid timestamps.`);
  if (!Array.isArray(value.exercises) || !value.exercises.length) throw new Error(`Workout ${position} has no exercises.`);
  const exercises: CompletedExercise[] = value.exercises.map((rawExercise, exerciseIndex) => {
    if (!isRecord(rawExercise) || typeof rawExercise.name !== "string" || !rawExercise.name.trim()) throw new Error(`Workout ${position}, exercise ${exerciseIndex + 1} is invalid.`);
    const priority = rawExercise.priority === "optional" ? "optional" : "must";
    const loadSuffix = typeof rawExercise.loadSuffix === "string" && rawExercise.loadSuffix ? rawExercise.loadSuffix : undefined;
    return {
      name: canonicalExerciseName(rawExercise.name), priority, ...(loadSuffix ? { loadSuffix } : {}),
      sets: normalizeSets(rawExercise.sets, `Workout ${position}, exercise ${exerciseIndex + 1}`).map(({ id, load, reps }) => ({ ...(id ? { id } : {}), load, reps })),
    };
  });
  const rawSync = isRecord(value.sync) && SYNC_STATUSES.includes(value.sync.status as WorkoutSync["status"])
    ? value.sync as WorkoutSync
    : { status: "legacy" as const };
  return {
    id,
    workout: value.workout,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    bodyweight: normalizeBodyweight(value.bodyweight, `Workout ${position}`),
    note: typeof value.note === "string" ? value.note.trim() : "",
    exercises,
    sync: rawSync,
  };
}

function csvCell(value: string | number) {
  const text = String(value);
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

function findWorkout(session: ExportSession, workouts: CompletedWorkout[]) {
  return workouts.find((workout) => session.sessionId === `${workout.id}:${session.exercise}`)
    ?? workouts.find((workout) => {
      const performed = Date.parse(session.performedAt);
      return performed >= Date.parse(workout.startedAt) && performed <= Date.parse(workout.endedAt)
        && workout.exercises.some((exercise) => canonicalExerciseName(exercise.name) === session.exercise);
    });
}

export function createJsonBackup(history: HistoryMap, workouts: CompletedWorkout[], exportedAt = new Date().toISOString()) {
  return JSON.stringify({ schemaVersion: 2, app: "Rolling PPL", exportedAt, sessions: exportSessions(history), workouts }, null, 2);
}

export function createCsvBackup(history: HistoryMap, workouts: CompletedWorkout[]) {
  const rows = exportSessions(history).flatMap((session) => {
    const workout = findWorkout(session, workouts);
    const exercise = workout?.exercises.find((item) => canonicalExerciseName(item.name) === session.exercise);
    return session.sets.map((set) => [
      session.exercise, session.performedAt.slice(0, 10), session.performedAt, session.sessionId,
      set.set, set.load || "BW", set.reps,
      workout?.id ?? "", workout?.workout ?? "", workout?.startedAt ?? "", workout?.endedAt ?? "",
      workout?.bodyweight ?? "", workout?.note ?? "", exercise?.priority ?? "", exercise?.loadSuffix ?? "",
    ]);
  });
  return `\uFEFF${[CSV_HEADERS, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
}

function parseCsvRows(text: string) {
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (character === '"') quoted = false; else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") { row.push(cell); cell = ""; }
    else if (character === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += character;
  }
  if (quoted) throw new Error("The CSV file has an unclosed quoted field.");
  if (cell || row.length) { row.push(cell.replace(/\r$/, "")); rows.push(row); }
  return rows;
}

type CsvWorkout = {
  id: string; workout: WorkoutKey; startedAt: string; endedAt: string; bodyweight: string; note: string;
  sessionKeys: Set<string>; exerciseMeta: Map<string, { priority: "must" | "optional"; loadSuffix?: string }>;
};

export function parseCsvBackup(text: string): ParsedBackup {
  const rows = parseCsvRows(text.replace(/^\uFEFF/, ""));
  const header = rows.shift()?.map((value) => value.trim()) ?? [];
  const required = ["exercise", "session_timestamp", "session_id", "set_number", "load", "reps"];
  const columns = Object.fromEntries(CSV_HEADERS.map((name) => [name, header.indexOf(name)]));
  if (required.some((name) => columns[name] < 0)) throw new Error("This is not a Rolling PPL CSV export.");
  const getRaw = (row: string[], name: string) => columns[name] >= 0 ? (row[columns[name]] ?? "") : "";
  const get = (row: string[], name: string) => getRaw(row, name).trim();
  const grouped = new Map<string, ExportSession>();
  const csvWorkouts = new Map<string, CsvWorkout>();
  rows.filter((item) => item.some((value) => value.trim())).forEach((item, rowIndex) => {
    const exercise = canonicalExerciseName(get(item, "exercise")); const sessionId = get(item, "session_id"); const performedAt = get(item, "session_timestamp"); const set = Number(get(item, "set_number")); const reps = get(item, "reps");
    if (!exercise || !sessionId || Number.isNaN(Date.parse(performedAt)) || !Number.isInteger(set) || set < 1 || Number(reps) <= 0) throw new Error(`CSV row ${rowIndex + 2} is invalid.`);
    const key = `${exercise}\u0000${sessionId}`;
    const session = grouped.get(key) ?? { exercise, sessionId, performedAt: new Date(performedAt).toISOString(), sets: [] };
    session.sets.push({ set, load: get(item, "load"), reps }); grouped.set(key, session);

    const workoutId = get(item, "workout_id");
    if (!workoutId) return;
    const workout = get(item, "workout"); const startedAt = get(item, "workout_started_at"); const endedAt = get(item, "workout_ended_at");
    if (!isWorkoutKey(workout) || Number.isNaN(Date.parse(startedAt)) || Number.isNaN(Date.parse(endedAt)) || Date.parse(endedAt) < Date.parse(startedAt)) throw new Error(`CSV row ${rowIndex + 2} has invalid workout metadata.`);
    const metadata = csvWorkouts.get(workoutId) ?? {
      id: workoutId, workout, startedAt: new Date(startedAt).toISOString(), endedAt: new Date(endedAt).toISOString(),
      bodyweight: normalizeBodyweight(get(item, "bodyweight"), `CSV row ${rowIndex + 2}`), note: getRaw(item, "session_note"),
      sessionKeys: new Set<string>(), exerciseMeta: new Map(),
    };
    if (metadata.workout !== workout || metadata.startedAt !== new Date(startedAt).toISOString() || metadata.endedAt !== new Date(endedAt).toISOString()) throw new Error(`CSV workout ${workoutId} has inconsistent metadata.`);
    metadata.sessionKeys.add(key);
    const loadSuffix = getRaw(item, "load_suffix");
    metadata.exerciseMeta.set(exercise, { priority: get(item, "exercise_priority") === "optional" ? "optional" : "must", ...(loadSuffix ? { loadSuffix } : {}) });
    csvWorkouts.set(workoutId, metadata);
  });
  if (!grouped.size) throw new Error("The export contains no sessions.");
  const sessions = Array.from(grouped.values()).map((session, index) => normalizeSession(session, index + 1));
  const byKey = new Map(sessions.map((session) => [`${session.exercise}\u0000${session.sessionId}`, session]));
  const workouts = Array.from(csvWorkouts.values()).map((workout) => ({
    id: workout.id, workout: workout.workout, startedAt: workout.startedAt, endedAt: workout.endedAt,
    bodyweight: workout.bodyweight, note: workout.note,
    exercises: Array.from(workout.sessionKeys).map((key) => byKey.get(key)).filter((session): session is ExportSession => Boolean(session)).map((session) => {
      const metadata = workout.exerciseMeta.get(session.exercise) ?? { priority: "must" as const };
      return { name: session.exercise, ...metadata, sets: session.sets.map(({ load, reps }) => ({ load, reps })) };
    }),
    sync: { status: "legacy" as const },
  })).sort((left, right) => right.endedAt.localeCompare(left.endedAt));
  return { sessions, workouts };
}

export function parseJsonBackup(text: string): ParsedBackup {
  let value: unknown; try { value = JSON.parse(text); } catch { throw new Error("The JSON file is not valid."); }
  if (!isRecord(value) || !Array.isArray(value.sessions)) throw new Error("This is not a Rolling PPL JSON export.");
  const sessions = value.sessions.map((session, index) => normalizeSession(session, index + 1));
  const workouts = Array.isArray(value.workouts) ? value.workouts.map((workout, index) => normalizeWorkout(workout, index + 1)) : [];
  if (!sessions.length && !workouts.length) throw new Error("The export contains no sessions.");
  return { sessions, workouts };
}

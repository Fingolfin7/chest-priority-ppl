import * as Automerge from "@automerge/automerge";
import { canonicalExerciseName, type HistoryMap, type SetEntry } from "./historyMigration.ts";
import type { DraftMap } from "./drafts.ts";
import type { ActiveWorkout, CompletedWorkout, WorkoutKey, WorkoutSync } from "./sessionModel.ts";

export type SyncSnapshot = {
  history: HistoryMap;
  completed: CompletedWorkout[];
  drafts: DraftMap;
  activeWorkout: ActiveWorkout | null;
  next: WorkoutKey;
  checkpoints: Record<string, { workoutId: string; fingerprint: string }>;
  bodyweight: string;
  sessionNote: string;
};

// One shared map object, with scalar registers at stable paths. Creating nested
// objects independently on two browsers would otherwise create object conflicts.
export type SyncData = { version: number; values: Record<string, Automerge.ImmutableString> };
export type SyncConflict = { key: string; label: string; options: Array<{ id: string; value: string }> };
type Scalar = string | number | boolean | null;
type Flat = Map<string, Scalar>;
type StableSet = SetEntry & { id?: string };
const UNASSIGNED = "unassigned";
const WORKOUTS = ["push", "pull", "legs"];
const STATUSES = ["unsynced", "syncing", "synced", "error", "legacy"];
const MAX_FIELDS = 250_000;
const MAX_TEXT = 100_000;
const pathKey = (...parts: string[]) => JSON.stringify(parts);
const sameSets = (a: SetEntry[], b: SetEntry[]) => JSON.stringify(a.map(({ load, reps }) => [load.trim(), reps.trim()])) === JSON.stringify(b.map(({ load, reps }) => [load.trim(), reps.trim()]));

// A fixed actor AND timestamp make this exact change identical on every browser.
const genesis = Automerge.change(Automerge.init<SyncData>({ actor: "00000000000000000000000000000001" }), { time: 0, message: "Rolling PPL sync schema 1" }, (draft) => {
  draft.version = 1;
  draft.values = {};
});

export function emptySyncSnapshot(): SyncSnapshot {
  return { history: {}, completed: [], drafts: {}, activeWorkout: null, next: "push", checkpoints: {}, bodyweight: "", sessionNote: "" };
}

function setId(kind: string, owner: string, exercise: string, set: StableSet, index: number) {
  return set.id || `legacy:${JSON.stringify([kind, owner, exercise, index])}`;
}

function belongsToWorkout(exercise: string, session: HistoryMap[string][number], workouts: CompletedWorkout[]) {
  return workouts.find((workout) => {
    const match = workout.exercises.find((item) => canonicalExerciseName(item.name) === exercise);
    return session.id === `${workout.id}:${exercise}` || Boolean(match && sameSets(session.sets, match.sets)
      && Date.parse(session.savedAt) >= Date.parse(workout.startedAt) && Date.parse(session.savedAt) <= Date.parse(workout.endedAt));
  });
}

function flatten(snapshot: SyncSnapshot, relatedWorkouts = snapshot.completed): Flat {
  const fields: Flat = new Map();
  const put = (parts: string[], value: Scalar) => fields.set(pathKey(...parts), value);
  const sets = (kind: string, owner: string, name: string, entries: SetEntry[]) => entries.forEach((set, index) => {
    const prefix = ["set", kind, owner, name, setId(kind, owner, name, set, index)];
    put([...prefix, "alive"], true); put([...prefix, "order"], index);
    put([...prefix, "load"], set.load); put([...prefix, "reps"], set.reps);
  });
  snapshot.completed.forEach((workout) => {
    const prefix = ["workout", workout.id];
    put([...prefix, "alive"], true);
    for (const field of ["workout", "startedAt", "endedAt", "bodyweight", "note"] as const) put([...prefix, field], workout[field]);
    // Receipts may sync; Autumn credentials and project preferences never enter
    // the document. A receipt is atomic so status and session ID stay together.
    put([...prefix, "sync"], JSON.stringify(Object.fromEntries(Object.entries(workout.sync).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)))));
    workout.exercises.forEach((exercise, index) => {
      const name = canonicalExerciseName(exercise.name);
      const exercisePrefix = ["exercise", workout.id, name];
      put([...exercisePrefix, "alive"], true); put([...exercisePrefix, "order"], index);
      put([...exercisePrefix, "priority"], exercise.priority); put([...exercisePrefix, "loadSuffix"], exercise.loadSuffix ?? "");
      sets("workout", workout.id, name, exercise.sets);
    });
  });
  for (const [storedName, sessions] of Object.entries(snapshot.history)) {
    const name = canonicalExerciseName(storedName);
    sessions.forEach((session) => {
      const workout = belongsToWorkout(name, session, relatedWorkouts);
      if (workout) {
        put(["historyLink", name, session.id], workout.id);
        return;
      }
      put(["history", name, session.id, "alive"], true); put(["history", name, session.id, "savedAt"], session.savedAt);
      sets("history", session.id, name, session.sets);
    });
  }
  put(["state", "activeId"], snapshot.activeWorkout?.id ?? null);
  put(["state", "next"], snapshot.next);
  if (snapshot.activeWorkout) {
    const active = snapshot.activeWorkout;
    put(["active", active.id, "alive"], true); put(["active", active.id, "workout"], active.workout);
    put(["active", active.id, "startedAt"], active.startedAt);
  }
  const scope = snapshot.activeWorkout?.id ?? UNASSIGNED;
  put(["draft", scope, "bodyweight"], snapshot.bodyweight); put(["draft", scope, "note"], snapshot.sessionNote);
  Object.entries(snapshot.drafts).forEach(([storedName, entries]) => {
    const name = canonicalExerciseName(storedName);
    put(["draftExercise", scope, name, "alive"], true); sets("draft", scope, name, entries);
  });
  Object.entries(snapshot.checkpoints).forEach(([name, checkpoint]) => {
    put(["checkpoint", checkpoint.workoutId, canonicalExerciseName(name)], JSON.stringify(checkpoint));
  });
  return fields;
}

function decoded(value: unknown, conflictValue = false): Scalar {
  if (!(conflictValue && typeof value === "string") && !Automerge.isImmutableString(value)) throw new Error("Sync data contains a non-scalar field.");
  const encoded = String(value);
  if (encoded.length > MAX_TEXT) throw new Error("A sync field is too large.");
  let result: unknown;
  try { result = JSON.parse(encoded); } catch { throw new Error("Sync data contains an invalid field."); }
  if (result !== null && !["string", "number", "boolean"].includes(typeof result)) throw new Error("Sync data contains an invalid scalar.");
  if (typeof result === "number" && !Number.isFinite(result)) throw new Error("Sync data contains an invalid number.");
  return result as Scalar;
}

function alternatives(doc: Automerge.Doc<SyncData>, key: string): Array<{ id: string; value: Scalar }> {
  const conflicts = Automerge.getConflicts(doc.values, key);
  return conflicts ? Object.entries(conflicts).map(([id, value]) => ({ id, value: decoded(value, true) })) : [];
}

function recordParents(parts: string[]): string[] {
  if (parts[0] === "workout" || parts[0] === "active") return [pathKey(parts[0], parts[1], "alive")];
  if (parts[0] === "exercise") return [pathKey("exercise", parts[1], parts[2], "alive"), pathKey("workout", parts[1], "alive")];
  if (parts[0] === "history") return [pathKey(parts[0], parts[1], parts[2], "alive")];
  if (parts[0] === "draftExercise") return [pathKey(parts[0], parts[1], parts[2], "alive"), ...(parts[1] === UNASSIGNED ? [] : [pathKey("active", parts[1], "alive")])];
  if (parts[0] === "set") {
    const parents = [pathKey(...parts.slice(0, -1), "alive")];
    if (parts[1] === "workout") parents.push(pathKey("exercise", parts[2], parts[3], "alive"), pathKey("workout", parts[2], "alive"));
    if (parts[1] === "history") parents.push(pathKey("history", parts[3], parts[2], "alive"));
    if (parts[1] === "draft") {
      parents.push(pathKey("draftExercise", parts[2], parts[3], "alive"));
      if (parts[2] !== UNASSIGNED) parents.push(pathKey("active", parts[2], "alive"));
    }
    return parents;
  }
  if (parts[0] === "draft" && parts[1] !== UNASSIGNED) return [pathKey("active", parts[1], "alive")];
  return [];
}

export function createSyncDoc(snapshot: SyncSnapshot = emptySyncSnapshot()): Automerge.Doc<SyncData> {
  let doc = Automerge.clone(genesis);
  const fields = flatten(snapshot);
  // An unused browser must not cast votes for its placeholder values when it
  // first meets a device with a real workout or next-workout selection.
  if (!snapshot.activeWorkout) fields.delete(pathKey("state", "activeId"));
  if (snapshot.next === "push" && !snapshot.completed.length && !Object.keys(snapshot.history).length && !snapshot.activeWorkout && !Object.keys(snapshot.drafts).length) fields.delete(pathKey("state", "next"));
  if (!snapshot.bodyweight) fields.delete(pathKey("draft", snapshot.activeWorkout?.id ?? UNASSIGNED, "bodyweight"));
  if (!snapshot.sessionNote) fields.delete(pathKey("draft", snapshot.activeWorkout?.id ?? UNASSIGNED, "note"));
  if (fields.size) doc = Automerge.change(doc, "Import this browser's existing workouts", (draft) => {
    fields.forEach((value, key) => { draft.values[key] = new Automerge.ImmutableString(JSON.stringify(value)); });
  });
  validateSyncDoc(doc);
  return doc;
}

export function updateSyncDoc(doc: Automerge.Doc<SyncData>, previous: SyncSnapshot, next: SyncSnapshot): Automerge.Doc<SyncData> {
  const related = [...previous.completed, ...next.completed];
  const before = flatten(previous, related); const after = flatten(next, related);
  const writes: Flat = new Map();
  after.forEach((value, key) => {
    if (before.get(key) === value) return;
    // Crash-journal replay must not duplicate operations or resolve a conflict.
    if (Object.hasOwn(doc.values, key) && decoded(doc.values[key]) === value) return;
    writes.set(key, value);
    // Concurrent deletion must not silently discard an edit. Touch the record's
    // membership register so delete/edit becomes an explicit retained conflict.
    const parts: string[] = JSON.parse(key);
    recordParents(parts).forEach((parent) => { if (after.get(parent) === true) writes.set(parent, true); });
    const activeScope = parts[0] === "draft" || parts[0] === "draftExercise" || parts[0] === "active" ? parts[1] : parts[0] === "set" && parts[1] === "draft" ? parts[2] : null;
    if (activeScope && activeScope === next.activeWorkout?.id) writes.set(pathKey("state", "activeId"), activeScope);
  });
  before.forEach((_value, key) => {
    if (after.has(key)) return;
    const parts: string[] = JSON.parse(key);
    if (parts.at(-1) === "alive") {
      // Delete the top-level removed record only, preserving its descendants
      // so choosing Keep restores the complete edited workout in one step.
      const parentRemoved = recordParents(parts).some((parent) => parent !== key && before.get(parent) === true && !after.has(parent));
      if (!parentRemoved && (!Object.hasOwn(doc.values, key) || decoded(doc.values[key]) !== false)) writes.set(key, false);
    }
    if (parts[0] === "checkpoint" && (!Object.hasOwn(doc.values, key) || decoded(doc.values[key]) !== null)) writes.set(key, null);
  });
  if (!writes.size) return doc;
  const changed = Automerge.change(doc, "Update workout data", (draft) => {
    writes.forEach((value, key) => { delete draft.values[key]; draft.values[key] = new Automerge.ImmutableString(JSON.stringify(value)); });
  });
  validateSyncDoc(changed);
  return changed;
}

function parsePath(key: string): string[] {
  if (key.length > 8_192) throw new Error("A sync record ID is too long.");
  let parts: unknown;
  try { parts = JSON.parse(key); } catch { throw new Error("Sync data contains an invalid field path."); }
  if (!Array.isArray(parts) || parts.some((part) => typeof part !== "string" || !part || part.length > 4_096)) throw new Error("Sync data contains an invalid field path.");
  return parts as string[];
}

function receipt(raw: Scalar): WorkoutSync {
  if (typeof raw !== "string") throw new Error("Invalid Autumn sync receipt.");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("Invalid Autumn sync receipt."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Autumn sync receipt.");
  const data = value as Record<string, unknown>;
  if (!STATUSES.includes(String(data.status))) throw new Error("Invalid Autumn sync status.");
  const allowed = ["status", "message", "projectId", "projectName", "autumnSessionId", "syncedAt"];
  if (Object.keys(data).some((key) => !allowed.includes(key))) throw new Error("Sync receipts cannot contain credentials or unknown fields.");
  for (const field of ["message", "projectName", "syncedAt"]) if (field in data && typeof data[field] !== "string") throw new Error("Invalid Autumn sync receipt text.");
  for (const field of ["projectId", "autumnSessionId"]) if (field in data && (typeof data[field] !== "number" || !Number.isSafeInteger(data[field]) || (data[field] as number) <= 0)) throw new Error("Invalid Autumn session identity.");
  if (data.syncedAt && !Number.isFinite(Date.parse(data.syncedAt as string))) throw new Error("Invalid Autumn sync date.");
  return data as WorkoutSync;
}

function checkpoint(raw: Scalar) {
  if (raw === null) return null;
  if (typeof raw !== "string") throw new Error("Invalid saved-exercise checkpoint.");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("Invalid saved-exercise checkpoint."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid saved-exercise checkpoint.");
  const data = value as Record<string, unknown>;
  if (typeof data.workoutId !== "string" || !data.workoutId || typeof data.fingerprint !== "string" || Object.keys(data).some((key) => !["workoutId", "fingerprint"].includes(key))) throw new Error("Invalid saved-exercise checkpoint.");
  return { workoutId: data.workoutId, fingerprint: data.fingerprint };
}

function validateField(parts: string[], value: Scalar) {
  const kind = parts[0]; const field = parts.at(-1);
  let validPath = false;
  if (kind === "workout" && parts.length === 3) validPath = ["alive", "workout", "startedAt", "endedAt", "bodyweight", "note", "sync"].includes(field!);
  if (kind === "active" && parts.length === 3) validPath = ["alive", "workout", "startedAt"].includes(field!);
  if (kind === "exercise" && parts.length === 4) validPath = ["alive", "priority", "loadSuffix", "order"].includes(field!);
  if (kind === "history" && parts.length === 4) validPath = ["alive", "savedAt"].includes(field!);
  if (kind === "draftExercise" && parts.length === 4) validPath = field === "alive";
  if (kind === "set" && parts.length === 6 && ["workout", "history", "draft"].includes(parts[1])) validPath = ["alive", "load", "reps", "order"].includes(field!);
  if (kind === "draft" && parts.length === 3) validPath = ["bodyweight", "note"].includes(field!);
  if (kind === "state" && parts.length === 2) validPath = ["activeId", "next"].includes(field!);
  if (kind === "historyLink" && parts.length === 3) {
    if (typeof value !== "string" || !value) throw new Error("Invalid legacy workout link.");
    return;
  }
  if (kind === "checkpoint" && parts.length === 3) { checkpoint(value); return; }
  if (!validPath) throw new Error("Sync data contains an unsupported field.");
  if (field === "alive") { if (typeof value !== "boolean") throw new Error("Invalid sync deletion marker."); return; }
  if (field === "order") { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 100_000) throw new Error("Invalid exercise order."); return; }
  if (field === "activeId" && value === null) return;
  if (typeof value !== "string") throw new Error("Sync data contains invalid text.");
  if ((field === "workout" || field === "next") && !WORKOUTS.includes(value)) throw new Error("Invalid workout type.");
  if (field === "priority" && !["must", "optional"].includes(value)) throw new Error("Invalid exercise priority.");
  if (["startedAt", "endedAt", "savedAt"].includes(field!) && !Number.isFinite(Date.parse(value))) throw new Error("Invalid workout date.");
  if (field === "bodyweight" && kind === "workout" && value && (!Number.isFinite(Number(value)) || Number(value) <= 0)) throw new Error("Invalid workout bodyweight.");
  if (kind === "set" && parts[1] !== "draft" && field === "reps" && (!value.trim() || !Number.isFinite(Number(value)) || Number(value) <= 0)) throw new Error("Invalid completed set reps.");
  if (field === "sync") receipt(value);
}

function readFields(doc: Automerge.Doc<SyncData>): Flat {
  if (doc.version !== 1 || !doc.values || typeof doc.values !== "object" || Array.isArray(doc.values) || Object.keys(doc).some((key) => !["version", "values"].includes(key))) throw new Error("Unsupported sync document.");
  if (Automerge.getConflicts(doc, "values") || Automerge.getConflicts(doc, "version")) throw new Error("Sync document has an incompatible schema root.");
  const entries = Object.entries(doc.values);
  if (entries.length > MAX_FIELDS) throw new Error("The sync document contains too many fields.");
  const fields: Flat = new Map();
  for (const [key, raw] of entries) {
    const parts = parsePath(key); const value = decoded(raw);
    validateField(parts, value);
    const choices = alternatives(doc, key);
    choices.forEach((choice) => validateField(parts, choice.value));
    // Deletion wins the projection until the user resolves its conflict. The
    // retained edit is still available and choosing Keep restores the record.
    fields.set(key, parts.at(-1) === "alive" && choices.some((choice) => choice.value === false) ? false : value);
  }
  return fields;
}

function projected(fields: Flat): SyncSnapshot {
  const entries = Array.from(fields, ([key, value]) => ({ parts: JSON.parse(key) as string[], value }));
  const get = (parts: string[], fallback?: Scalar) => fields.get(pathKey(...parts)) ?? fallback;
  const text = (parts: string[], fallback?: string): string => {
    const value = get(parts, fallback);
    if (typeof value !== "string") throw new Error("A sync record is missing required text.");
    return value;
  };
  const live = (...parts: string[]) => get([...parts, "alive"]) === true;
  const ids = (kind: string) => entries.filter(({ parts }) => parts[0] === kind && parts.at(-1) === "alive").map(({ parts }) => parts.slice(1, -1));
  const sets = (kind: string, owner: string, name: string): SetEntry[] => ids("set")
    .filter((parts) => parts[0] === kind && parts[1] === owner && parts[2] === name && live("set", ...parts))
    .sort((left, right) => Number(get(["set", ...left, "order"], 0)) - Number(get(["set", ...right, "order"], 0)) || left[3].localeCompare(right[3]))
    .map((parts) => ({ id: parts[3], load: text(["set", ...parts, "load"]), reps: text(["set", ...parts, "reps"]) }));
  const allWorkouts: CompletedWorkout[] = [];
  const completed: CompletedWorkout[] = [];
  for (const [id] of ids("workout")) {
    const prefix = ["workout", id];
    const exercises = ids("exercise").filter(([owner, name]) => owner === id && live("exercise", owner, name))
      .sort((left, right) => Number(get(["exercise", ...left, "order"], 0)) - Number(get(["exercise", ...right, "order"], 0)) || left[1].localeCompare(right[1]))
      .map(([owner, name]) => {
        const loadSuffix = text(["exercise", owner, name, "loadSuffix"], "");
        return { name, priority: text(["exercise", owner, name, "priority"]) as "must" | "optional", ...(loadSuffix ? { loadSuffix } : {}), sets: sets("workout", id, name) };
      });
    const workout: CompletedWorkout = {
      id, workout: text([...prefix, "workout"]) as WorkoutKey, startedAt: text([...prefix, "startedAt"]), endedAt: text([...prefix, "endedAt"]),
      bodyweight: text([...prefix, "bodyweight"], ""), note: text([...prefix, "note"], ""), exercises, sync: receipt(text([...prefix, "sync"])),
    };
    if (Date.parse(workout.endedAt) < Date.parse(workout.startedAt)) throw new Error("A synced workout ends before it starts.");
    allWorkouts.push(workout);
    if (live(...prefix)) completed.push(workout);
  }
  completed.sort((a, b) => b.endedAt.localeCompare(a.endedAt) || a.id.localeCompare(b.id));
  const history: HistoryMap = {};
  const append = (name: string, session: HistoryMap[string][number]) => {
    if (!Object.hasOwn(history, name)) Object.defineProperty(history, name, { value: [], enumerable: true, configurable: true, writable: true });
    if (!history[name].some((item) => item.id === session.id)) history[name].push(session);
  };
  for (const [name, id] of ids("history")) {
    if (!live("history", name, id)) continue;
    const session = { id, savedAt: text(["history", name, id, "savedAt"]), sets: sets("history", id, name) };
    const linkedWorkout = get(["historyLink", name, id]);
    if (!allWorkouts.some((workout) => workout.id === linkedWorkout) && !belongsToWorkout(name, session, allWorkouts)) append(name, session);
  }
  // Completed workouts are authoritative for their derived progression history.
  // This also removes stale lift copies after a workout edit or deletion.
  completed.forEach((workout) => workout.exercises.forEach((exercise) => {
    if (exercise.sets.length) append(exercise.name, { id: `${workout.id}:${exercise.name}`, savedAt: workout.endedAt, sets: exercise.sets });
  }));
  Object.values(history).forEach((sessions) => sessions.sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.id.localeCompare(b.id)));
  const activeId = get(["state", "activeId"]);
  let activeWorkout: ActiveWorkout | null = null;
  if (typeof activeId === "string" && live("active", activeId)) {
    activeWorkout = { id: activeId, workout: text(["active", activeId, "workout"]) as WorkoutKey, startedAt: text(["active", activeId, "startedAt"]) };
  }
  const scope = activeWorkout?.id ?? UNASSIGNED;
  const drafts: DraftMap = Object.fromEntries(ids("draftExercise").filter(([owner, name]) => owner === scope && live("draftExercise", owner, name)).map(([owner, name]) => [name, sets("draft", owner, name)]));
  const checkpoints: SyncSnapshot["checkpoints"] = {};
  for (const { parts, value } of entries) {
    if (parts[0] !== "checkpoint" || parts[1] !== activeWorkout?.id) continue;
    const saved = checkpoint(value); if (!saved || saved.workoutId !== activeWorkout?.id) continue;
    const selected = (drafts[parts[2]] ?? []).map(({ load, reps }) => ({ load: load.trim(), reps: reps.trim() }));
    while (selected.length && !selected.at(-1)!.load && !selected.at(-1)!.reps) selected.pop();
    // A merge can change a set independently of its saved checkpoint. Never
    // display a false Saved badge for data the user has not confirmed.
    if (saved.fingerprint === JSON.stringify(selected)) Object.defineProperty(checkpoints, parts[2], { value: saved, enumerable: true, configurable: true, writable: true });
  }
  return { history, completed, drafts, activeWorkout, next: text(["state", "next"], "push") as WorkoutKey, checkpoints,
    bodyweight: text(["draft", scope, "bodyweight"], ""), sessionNote: text(["draft", scope, "note"], "") };
}

export function validateSyncDoc(doc: Automerge.Doc<SyncData>): void {
  projected(readFields(doc));
}

export function projectSyncDoc(doc: Automerge.Doc<SyncData>): SyncSnapshot {
  return projected(readFields(doc));
}

function conflictLabel(parts: string[], fields: Flat) {
  const field = parts.at(-1)!;
  const friendly: Record<string, string> = { alive: "deletion", load: "weight", reps: "reps", note: "note", bodyweight: "bodyweight", next: "next workout", activeId: "active workout", sync: "Autumn receipt", order: "order", startedAt: "start time", endedAt: "end time" };
  if (parts[0] === "set") return `${parts[3]} · set ${Number(fields.get(pathKey(...parts.slice(0, -1), "order")) ?? 0) + 1} · ${friendly[field] ?? field}`;
  if (parts[0] === "exercise" || parts[0] === "draftExercise" || parts[0] === "checkpoint") return `${parts[2]} · ${friendly[field] ?? "saved exercise"}`;
  if (parts[0] === "workout" || parts[0] === "active") {
    const workout = String(fields.get(pathKey(parts[0], parts[1], "workout")) ?? "Workout");
    const date = String(fields.get(pathKey(parts[0], parts[1], "startedAt")) ?? "").slice(0, 10);
    return `${parts[0] === "active" ? "In-progress " : ""}${workout[0].toUpperCase()}${workout.slice(1)} ${date} · ${friendly[field] ?? field}`;
  }
  return friendly[field] ?? field;
}

export function listSyncConflicts(doc: Automerge.Doc<SyncData>): SyncConflict[] {
  const fields = readFields(doc);
  const result: SyncConflict[] = [];
  for (const key of Object.keys(doc.values)) {
    const options = alternatives(doc, key);
    const unique = Array.from(new Map(options.map((option) => [JSON.stringify(option.value), option])).values());
    if (unique.length < 2) continue; // Identical independent imports are not conflicts.
    const parts = parsePath(key);
    result.push({ key, label: conflictLabel(parts, fields), options: unique.map(({ id, value }) => ({ id, value: parts.at(-1) === "alive" ? (value ? "Keep record" : "Delete record") : value === null ? "None" : String(value) })) });
  }
  return result.sort((a, b) => a.key.localeCompare(b.key));
}

export function resolveSyncConflict(doc: Automerge.Doc<SyncData>, key: string, optionId: string): Automerge.Doc<SyncData> {
  const choice = alternatives(doc, key).find((option) => option.id === optionId);
  if (!choice) throw new Error("This conflict changed. Please choose again.");
  const result = Automerge.change(doc, "Resolve a sync conflict", (draft) => { delete draft.values[key]; draft.values[key] = new Automerge.ImmutableString(JSON.stringify(choice.value)); });
  validateSyncDoc(result);
  return result;
}

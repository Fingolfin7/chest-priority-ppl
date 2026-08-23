import { Fragment, StrictMode, useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  DEFAULT_AUTUMN_URL, defaultAutumnSettings, getAutumnAccount, listAutumnProjects,
  pushWorkoutToAutumn, signInToAutumn, type AutumnProject, type AutumnSettings,
} from "./autumn";
import { pruneCompletedDrafts, type DraftMap } from "./drafts";
import { canonicalExerciseName, canonicalizeHistory, type HistoryMap, type SavedSession, type SetEntry } from "./historyMigration";
import { nextStep, setTarget } from "./progression";
import {
  WORKOUT_SEQUENCE, addWorkoutToHistory, completeWorkout, createActiveWorkout, elapsedLabel, liftMilestones,
  migrateLegacyHistory, nextWorkout as followingWorkout, sessionsInLastDays, workoutDurationMinutes,
  workoutSummary, type ActiveWorkout, type CompletedWorkout, type WorkoutKey,
} from "./sessionModel";
import "./styles.css";

type Theme = "light" | "dark";
type Demo = { label: string; slug: string };
type Exercise = {
  name: string; sets: string; reps: string; rest: string; warmup: string; cue: string;
  priority: "must" | "optional"; loadSuffix?: string; demos: Demo[];
};
type LightboxImage = { src: string; alt: string };
type ExportFormat = "json" | "csv";
type ExportSession = { exercise: string; sessionId: string; performedAt: string; sets: Array<SetEntry & { set: number }> };
type ImportResult = { kind: "success" | "error"; message: string } | null;
type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

const HISTORY_KEY = "rolling-ppl-history-v1";
const DRAFTS_KEY = "rolling-ppl-drafts-v1";
const THEME_KEY = "rolling-ppl-theme-v1";
const WORKOUTS_KEY = "rolling-ppl-workouts-v2";
const ACTIVE_WORKOUT_KEY = "rolling-ppl-active-workout-v2";
const NEXT_WORKOUT_KEY = "rolling-ppl-next-workout-v1";
const AUTUMN_KEY = "rolling-ppl-autumn-v1";

function readStored<T>(key: string, fallback: T): T {
  const value = localStorage.getItem(key);
  if (value === null) return fallback;
  try { return JSON.parse(value) as T; }
  catch { return typeof fallback === "string" ? value as T : fallback; }
}

function storeLocal(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { /* The app remains usable when storage is unavailable. */ }
}

function isWorkoutKey(value: unknown): value is WorkoutKey { return value === "push" || value === "pull" || value === "legs"; }

function exportSessions(history: HistoryMap): ExportSession[] {
  return Object.entries(history).flatMap(([exercise, sessions]) => sessions.map((session) => ({
    exercise, sessionId: session.id, performedAt: session.savedAt,
    sets: session.sets.map((set, index) => ({ set: index + 1, ...set })),
  }))).sort((left, right) => right.performedAt.localeCompare(left.performedAt));
}

function csvCell(value: string | number) {
  const text = String(value);
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

function downloadHistory(history: HistoryMap, completedWorkouts: CompletedWorkout[], format: ExportFormat) {
  const sessions = exportSessions(history);
  const dateStamp = new Date().toISOString().slice(0, 10);
  let content: string;
  let mimeType: string;
  if (format === "json") {
    content = JSON.stringify({ schemaVersion: 2, app: "Rolling PPL", exportedAt: new Date().toISOString(), sessions, workouts: completedWorkouts }, null, 2);
    mimeType = "application/json;charset=utf-8";
  } else {
    const rows = sessions.flatMap((session) => session.sets.map((set) => [session.exercise, session.performedAt.slice(0, 10), session.performedAt, session.sessionId, set.set, set.load || "BW", set.reps]));
    content = `\uFEFF${[["exercise", "session_date", "session_timestamp", "session_id", "set_number", "load", "reps"], ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
    mimeType = "text/csv;charset=utf-8";
  }
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url; link.download = `rolling-ppl-history-${dateStamp}.${format}`; document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function normalizeSession(value: unknown, position: number): ExportSession {
  if (!isRecord(value)) throw new Error(`Session ${position} is not an object.`);
  const exercise = typeof value.exercise === "string" ? canonicalExerciseName(value.exercise) : "";
  const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
  const performedAt = typeof value.performedAt === "string" ? value.performedAt.trim() : "";
  if (!exercise || !sessionId) throw new Error(`Session ${position} is missing an exercise or session ID.`);
  if (!performedAt || Number.isNaN(Date.parse(performedAt))) throw new Error(`Session ${position} has an invalid timestamp.`);
  if (!Array.isArray(value.sets) || !value.sets.length) throw new Error(`Session ${position} has no work sets.`);
  const sets = value.sets.map((rawSet, index) => {
    if (!isRecord(rawSet)) throw new Error(`Session ${position}, set ${index + 1} is invalid.`);
    const load = rawSet.load == null ? "" : String(rawSet.load).trim();
    const reps = rawSet.reps == null ? "" : String(rawSet.reps).trim();
    const set = Number(rawSet.set ?? index + 1);
    if (!Number.isInteger(set) || set < 1 || !reps || !Number.isFinite(Number(reps)) || Number(reps) <= 0) throw new Error(`Session ${position}, set ${index + 1} is invalid.`);
    return { set, load, reps };
  }).sort((left, right) => left.set - right.set);
  return { exercise, sessionId, performedAt: new Date(performedAt).toISOString(), sets };
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

function parseCsvSessions(text: string) {
  const rows = parseCsvRows(text.replace(/^\uFEFF/, ""));
  const header = rows.shift()?.map((value) => value.trim()) ?? [];
  const required = ["exercise", "session_timestamp", "session_id", "set_number", "load", "reps"];
  const columns = Object.fromEntries(required.map((name) => [name, header.indexOf(name)]));
  if (required.some((name) => columns[name] < 0)) throw new Error("This is not a Rolling PPL CSV export.");
  const grouped = new Map<string, ExportSession>();
  rows.filter((item) => item.some((value) => value.trim())).forEach((item, rowIndex) => {
    const get = (name: string) => (item[columns[name]] ?? "").trim();
    const exercise = get("exercise"); const sessionId = get("session_id"); const performedAt = get("session_timestamp"); const set = Number(get("set_number")); const reps = get("reps");
    if (!exercise || !sessionId || Number.isNaN(Date.parse(performedAt)) || !Number.isInteger(set) || set < 1 || Number(reps) <= 0) throw new Error(`CSV row ${rowIndex + 2} is invalid.`);
    const key = `${exercise}\u0000${sessionId}`;
    const session = grouped.get(key) ?? { exercise, sessionId, performedAt: new Date(performedAt).toISOString(), sets: [] };
    session.sets.push({ set, load: get("load"), reps }); grouped.set(key, session);
  });
  if (!grouped.size) throw new Error("The export contains no sessions.");
  return Array.from(grouped.values()).map((session, index) => normalizeSession(session, index + 1));
}

function parseJsonBackup(text: string) {
  let value: unknown; try { value = JSON.parse(text); } catch { throw new Error("The JSON file is not valid."); }
  if (!isRecord(value) || !Array.isArray(value.sessions)) throw new Error("This is not a Rolling PPL JSON export.");
  const sessions = value.sessions.map((session, index) => normalizeSession(session, index + 1));
  const workouts = Array.isArray(value.workouts) ? value.workouts.filter((workout): workout is CompletedWorkout => {
    if (!isRecord(workout) || typeof workout.id !== "string" || !isWorkoutKey(workout.workout) || !Array.isArray(workout.exercises)) return false;
    return typeof workout.startedAt === "string" && typeof workout.endedAt === "string" && !Number.isNaN(Date.parse(workout.startedAt)) && !Number.isNaN(Date.parse(workout.endedAt));
  }) : [];
  if (!sessions.length && !workouts.length) throw new Error("The export contains no sessions.");
  return { sessions, workouts };
}

function setRange(value: string) { const values = value.match(/\d+/g)?.map(Number) ?? [1]; return { min: values[0], max: values.at(-1) ?? values[0] }; }
function formatSession(session: SavedSession) { return session.sets.map((entry) => `${entry.load.trim() || "BW"} × ${entry.reps}`).join(" · "); }

const workouts: Record<WorkoutKey, { summary: string; exercises: Exercise[] }> = {
  push: { summary: "6 exercises · chest priority", exercises: [
    { name: "Barbell bench press", sets: "3–4", reps: "5–8", rest: "2–4 min", warmup: "3–4 ramp sets", cue: "Set your upper back, plant your feet, and touch the same lower-chest point each rep. The fourth work set is optional.", priority: "must", demos: [{ label: "Bench press", slug: "bench" }] },
    { name: "Incline dumbbell bench press", sets: "3", reps: "6–10", rest: "2–3 min", warmup: "1–2 ramp sets × 6–8", cue: "Use a modest incline. Lower with control and press up and slightly inward.", priority: "must", loadSuffix: " each", demos: [{ label: "Incline press", slug: "incline-press" }] },
    { name: "Lateral raise", sets: "2–3", reps: "12–20", rest: "60–90 sec", warmup: "1 light set × 15–20", cue: "Lead with your elbows, stop near shoulder height, and keep momentum out of it.", priority: "must", loadSuffix: " each", demos: [{ label: "Lateral raise", slug: "lateral-raise" }] },
    { name: "Cable triceps pushdown", sets: "3", reps: "8–12", rest: "60–90 sec", warmup: "1 light set × 12–15", cue: "Pin your upper arms, extend fully, then control the return.", priority: "must", demos: [{ label: "Pushdown", slug: "pushdown" }] },
    { name: "Overhead dumbbell triceps extension", sets: "2–3", reps: "10–15", rest: "60–90 sec", warmup: "1 light set × 12–15", cue: "Hold one dumbbell with both hands. Keep your upper arms steady and use a comfortable depth. The third work set is optional.", priority: "optional", demos: [{ label: "Overhead dumbbell extension", slug: "overhead-db-extension" }] },
    { name: "Chest press machine", sets: "2", reps: "8–12", rest: "90–120 sec", warmup: "1 light ramp set × 8–10", cue: "Set the seat so the handles meet mid-chest. Keep your upper back planted and control the return.", priority: "optional", demos: [{ label: "Chest press machine", slug: "chest-press-machine" }] },
  ] },
  pull: { summary: "5 exercises · back + biceps", exercises: [
    { name: "Bent-over barbell row", sets: "3", reps: "6–10", rest: "2–3 min", warmup: "2–3 ramp sets × 5–8", cue: "Brace before you pull, keep your torso angle steady, and drive your elbows toward your hips.", priority: "must", demos: [{ label: "Barbell row", slug: "barbell-row" }] },
    { name: "Lat pulldown or pull-ups", sets: "3", reps: "6–12", rest: "2–3 min", warmup: "1 light or assisted set × 8–10", cue: "Start by bringing your shoulders down, then pull your elbows toward your ribs without swinging.", priority: "must", demos: [{ label: "Lat pulldown", slug: "lat-pulldown" }, { label: "Pull-ups", slug: "pullups" }] },
    { name: "Rear-delt fly", sets: "2–3", reps: "12–20", rest: "60–90 sec", warmup: "1 light set × 15–20", cue: "Use your rear delts and upper back. Keep your ribs down and avoid shrugging.", priority: "must", demos: [{ label: "Rear-delt fly", slug: "rear-delt-fly" }] },
    { name: "Barbell curl", sets: "3", reps: "8–12", rest: "60–90 sec", warmup: "1 light set × 10–12", cue: "Keep your upper arms quiet, curl without leaning back, and own the lowering phase.", priority: "must", demos: [{ label: "Barbell curl", slug: "barbell-curl" }] },
    { name: "Dumbbell hammer curl", sets: "2–3", reps: "8–12", rest: "60–90 sec", warmup: "1 light set × 10–12", cue: "Keep a neutral grip, leave your elbows by your sides, and lower without swinging. The third work set is optional.", priority: "optional", loadSuffix: " each", demos: [{ label: "Hammer curl", slug: "hammer-curl" }] },
  ] },
  legs: { summary: "6 exercises · squat + hinge", exercises: [
    { name: "Back squat", sets: "3", reps: "5–8", rest: "3–5 min", warmup: "3–4 ramp sets", cue: "Brace before descending, keep pressure through your whole foot, and use safeties just below depth.", priority: "must", demos: [{ label: "Back squat", slug: "back-squat" }] },
    { name: "Conventional deadlift", sets: "2", reps: "4–6", rest: "3–5 min", warmup: "2–3 ramp sets × 3–5", cue: "Wedge into the bar, push the floor away, and finish tall without leaning back.", priority: "must", demos: [{ label: "Deadlift", slug: "deadlift" }] },
    { name: "Leg curl", sets: "3", reps: "10–15", rest: "60–90 sec", warmup: "1 light set × 12–15", cue: "Keep your hips anchored, curl through your hamstrings, and lower without letting the stack crash.", priority: "must", demos: [{ label: "Leg curl", slug: "leg-curl" }] },
    { name: "Leg press or Bulgarian split squat", sets: "2–3", reps: "8–12", rest: "2–3 min", warmup: "1–2 light sets × 8", cue: "Choose the option you can control through a comfortable range. Keep your knee tracking over your foot.", priority: "optional", demos: [{ label: "Leg press", slug: "leg-press" }, { label: "Split squat", slug: "split-squat" }] },
    { name: "Calf raise", sets: "2–3", reps: "10–15", rest: "60–90 sec", warmup: "1 easy set × 12–15", cue: "Use a full comfortable stretch, pause briefly at the top, and avoid bouncing. The third work set is optional.", priority: "optional", demos: [{ label: "Calf raise", slug: "calf-raise" }] },
    { name: "Ab crunch machine", sets: "2–3", reps: "10–15", rest: "60–90 sec", warmup: "1 light set × 12–15", cue: "Bring your ribs toward your pelvis, pause in the crunch, and control the return. The third work set is optional.", priority: "optional", demos: [{ label: "Ab crunch machine", slug: "ab-crunch-machine" }] },
  ] },
};

const exerciseWorkouts = Object.fromEntries(WORKOUT_SEQUENCE.flatMap((workout) => workouts[workout].exercises.map((exercise) => [exercise.name, workout]))) as Record<string, WorkoutKey>;

function DemoStrip({ demo, exercise, onOpen }: { demo: Demo; exercise: string; onOpen: (image: LightboxImage) => void }) {
  const poses = [{ src: `./exercises/${demo.slug}-0.jpg`, alt: `${demo.label}: first position` }, { src: `./exercises/${demo.slug}-1.jpg`, alt: `${demo.label}: second position` }];
  return <figure className="demo-strip"><div className="poses"><button className="image-button" type="button" onClick={() => onOpen(poses[0])} aria-label={`Enlarge ${poses[0].alt}`}><img src={poses[0].src} alt={poses[0].alt} loading="lazy" /></button><span aria-hidden="true">→</span><button className="image-button" type="button" onClick={() => onOpen(poses[1])} aria-label={`Enlarge ${poses[1].alt}`}><img src={poses[1].src} alt={poses[1].alt} loading="lazy" /></button></div><figcaption>{demo.label}</figcaption><a className="image-source" href="https://github.com/yuhonas/free-exercise-db" target="_blank" rel="noreferrer" aria-label={`Public-domain image source for ${exercise}`}>source</a></figure>;
}

function TrainingRail({ next, active, now, finishing, latest, syncBusy, onSetNext, onStart, onFinish, onCancel, onSync }: {
  next: WorkoutKey; active: ActiveWorkout | null; now: number; finishing: boolean; latest?: CompletedWorkout; syncBusy: boolean;
  onSetNext: (workout: WorkoutKey) => void; onStart: () => void; onFinish: () => void; onCancel: () => void; onSync: (session: CompletedWorkout) => void;
}) {
  const workout = active?.workout ?? next;
  return <section className={`training-rail ${workout}`} aria-labelledby="training-title">
    <div className="rail-main">
      <div className="rail-copy"><span className="eyebrow">{active ? "Workout in progress" : "Next workout"}</span><h2 id="training-title">{workout}</h2><p>{active ? `Started ${new Date(active.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "The sequence moves only when you finish."}</p></div>
      {active ? <div className="rail-live"><strong aria-label={`Elapsed time ${elapsedLabel(active.startedAt, now)}`}>{elapsedLabel(active.startedAt, now)}</strong><button className="primary-action" type="button" onClick={onFinish} disabled={finishing}>Finish workout</button><button className="text-action" type="button" onClick={onCancel}>Cancel</button></div>
        : <div className="rail-start"><div className="sequence-dots" aria-label="Push, Pull, Legs sequence">{WORKOUT_SEQUENCE.map((item) => <span key={item} className={item === next ? "current" : ""}>{item}</span>)}</div><button className="primary-action" type="button" onClick={onStart}>Start {next}</button><details className="next-picker"><summary>Change next</summary><div>{WORKOUT_SEQUENCE.map((item) => <button type="button" key={item} onClick={() => onSetNext(item)}>{item}</button>)}</div></details></div>}
    </div>
    {!active && latest && latest.sync.status !== "legacy" && <div className={`sync-receipt ${latest.sync.status}`}><div><span>{latest.sync.status === "synced" ? "Autumn receipt" : "Saved on this device"}</span><strong>{latest.workout[0].toUpperCase() + latest.workout.slice(1)} · {workoutDurationMinutes(latest)} min</strong><small>{latest.sync.status === "synced" ? `Synced to ${latest.sync.projectName}` : latest.sync.message || "Ready to sync when you are."}</small></div>{latest.sync.status !== "synced" ? <button type="button" disabled={syncBusy} onClick={() => onSync(latest)}>{syncBusy ? "Syncing…" : "Sync to Autumn"}</button> : <b aria-label="Synced">✓</b>}</div>}
  </section>;
}

function FinishWorkout({ workout, bodyweight, note, error, onBodyweight, onNote, onBack, onSave }: {
  workout: WorkoutKey; bodyweight: string; note: string; error: string; onBodyweight: (value: string) => void; onNote: (value: string) => void; onBack: () => void; onSave: () => void;
}) {
  return <section className="finish-panel" aria-labelledby="finish-title"><div><span className="eyebrow">Finish {workout}</span><h2 id="finish-title">Close the session</h2><p>Both fields are optional. Your completed sets will form the Autumn note.</p></div><div className="finish-fields"><label><span>Bodyweight</span><div><input value={bodyweight} onChange={(event) => onBodyweight(event.target.value)} inputMode="decimal" placeholder="64.6" /><small>kg</small></div></label><label><span>Session note</span><textarea value={note} onChange={(event) => onNote(event.target.value)} rows={3} placeholder="How it felt, anything unusual…" /></label></div>{error && <p className="form-error" role="alert">{error}</p>}<div className="finish-actions"><button type="button" className="primary-action" onClick={onSave}>Save workout</button><button type="button" className="secondary-action" onClick={onBack}>Keep training</button></div></section>;
}

function ExerciseRow({ exercise, index, onOpen, history, draft, enabled, onDraftChange }: {
  exercise: Exercise; index: number; onOpen: (image: LightboxImage) => void; history: SavedSession[]; draft: SetEntry[]; enabled: boolean; onDraftChange: (entries: SetEntry[]) => void;
}) {
  const range = setRange(exercise.sets);
  const entries = Array.from({ length: range.max }, (_, setIndex) => draft[setIndex] ?? { load: "", reps: "" });
  const previous = history[0];
  const updateEntry = (setIndex: number, field: keyof SetEntry, value: string) => onDraftChange(entries.map((entry, entryIndex) => entryIndex === setIndex ? { ...entry, [field]: value } : entry));
  return <article className={`exercise-row ${exercise.priority} ${enabled ? "logging" : "reference"}`}>
    <div className={`demo-grid ${exercise.demos.length > 1 ? "has-options" : ""}`}>{exercise.demos.map((demo) => <DemoStrip key={demo.slug} demo={demo} exercise={exercise.name} onOpen={onOpen} />)}</div>
    <div className="exercise-info"><div className="exercise-title"><span>{index + 1}</span><h3>{exercise.name}</h3><strong className={`priority-badge ${exercise.priority}`}>{exercise.priority === "must" ? "Must do" : "If time"}</strong></div><div className="prescription"><strong>{exercise.sets}</strong><small>sets</small><i>×</i><strong>{exercise.reps}</strong><small>reps</small></div><p className="cue">{exercise.cue}</p><div className="exercise-meta"><span>Optional warm-up: {exercise.warmup}</span><span>Rest: {exercise.rest}</span><span>Start around 2 RIR</span></div>
      <section className="set-tracker" aria-label={`Progressive overload log for ${exercise.name}`}><div className="tracker-heading"><div><h4>{enabled ? "Log work sets" : "Today's targets"}</h4><p>{enabled ? "Autosaved with this workout." : "Start this workout to enter sets."}</p></div>{previous && <div className="previous-session"><span>Previous</span><strong>{formatSession(previous)}</strong></div>}</div><div className="set-entries">{entries.map((entry, setIndex) => { const target = setTarget(exercise.reps, history, setIndex, range.min); return <div className="set-entry" key={setIndex}><div className="set-number">Set {setIndex + 1}{setIndex >= range.min && <small>optional</small>}</div><label><span>Load</span><input disabled={!enabled} className={target ? "has-target" : ""} value={entry.load} onChange={(event) => updateEntry(setIndex, "load", event.target.value)} inputMode="decimal" maxLength={12} placeholder={target?.load ?? "kg / BW"} aria-label={`${exercise.name} set ${setIndex + 1} load${target ? `, target ${target.load}` : ""}`} /></label><label><span>Reps</span><input disabled={!enabled} className={target ? "has-target" : ""} value={entry.reps} onChange={(event) => updateEntry(setIndex, "reps", event.target.value)} type="number" inputMode="numeric" min="0" max="99" placeholder={target?.reps ?? "0"} aria-label={`${exercise.name} set ${setIndex + 1} reps${target ? `, target ${target.reps}` : ""}`} /></label></div>; })}</div><div className="next-step"><span>Next target</span><strong>{nextStep(exercise.reps, history, range.min)}</strong></div>{history.length > 0 && <details className="history"><summary>History ({history.length})</summary><ol>{history.slice(0, 5).map((session) => <li key={session.id}><time dateTime={session.savedAt}>{new Date(session.savedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time><span>{formatSession(session)}</span></li>)}</ol></details>}</section>
    </div>
  </article>;
}

function Workout({ workout, onOpen, history, drafts, enabled, onDraftChange }: { workout: WorkoutKey; onOpen: (image: LightboxImage) => void; history: HistoryMap; drafts: DraftMap; enabled: boolean; onDraftChange: (name: string, entries: SetEntry[]) => void }) {
  const data = workouts[workout]; const mustDoCount = data.exercises.filter((exercise) => exercise.priority === "must").length; const optionalCount = data.exercises.length - mustDoCount;
  return <section className={`workout ${workout}`} aria-labelledby={`${workout}-title`}><header className="workout-header"><div><h2 id={`${workout}-title`}>{workout}</h2><p>{data.summary}</p></div><span>{mustDoCount} must · {optionalCount} if time</span></header><p className="short-session"><strong>Minimum version:</strong> complete every Must do card when you can. A shortened session still advances the sequence.</p><div className="exercise-list">{data.exercises.map((exercise, index) => <Fragment key={exercise.name}>{index === mustDoCount && <div className="optional-divider"><span>If time</span><p>Useful additions, already ranked. Stop whenever you need to.</p></div>}<ExerciseRow exercise={exercise} index={index} onOpen={onOpen} history={history[exercise.name] ?? []} draft={drafts[exercise.name] ?? []} enabled={enabled} onDraftChange={(entries) => onDraftChange(exercise.name, entries)} /></Fragment>)}</div></section>;
}

function BodyweightChart({ sessions }: { sessions: CompletedWorkout[] }) {
  const readings = sessions.filter((session) => Number(session.bodyweight) > 0).slice(0, 10).reverse().map((session) => ({ date: session.endedAt, value: Number(session.bodyweight) }));
  if (!readings.length) return <div className="empty-progress"><strong>No bodyweight readings yet.</strong><span>Add one when finishing a workout.</span></div>;
  const values = readings.map((reading) => reading.value); const min = Math.min(...values); const max = Math.max(...values); const spread = Math.max(0.5, max - min);
  const coordinates = readings.map((reading, index) => ({ x: readings.length === 1 ? 100 : 10 + index * (180 / (readings.length - 1)), y: 72 - ((reading.value - min) / spread) * 54 }));
  const points = coordinates.map(({ x, y }) => `${x},${y}`).join(" "); const latest = readings.at(-1)!;
  return <div className="weight-chart"><div><strong>{latest.value.toFixed(2)} kg</strong><span>Latest · {new Date(latest.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span></div><svg viewBox="0 0 200 90" role="img" aria-label={`Bodyweight moved from ${readings[0].value} to ${latest.value} kilograms across ${readings.length} readings`}><line x1="10" y1="72" x2="190" y2="72" /><polyline points={points} />{coordinates.map(({ x, y }, index) => <circle key={`${x}-${y}-${index}`} cx={x} cy={y} r="2.8" />)}</svg><ol>{readings.map((reading) => <li key={reading.date}><time>{new Date(reading.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time><strong>{reading.value.toFixed(2)} kg</strong></li>)}</ol></div>;
}

function bestRecordedSet(sessions: SavedSession[]) {
  const sets = sessions.flatMap((session) => session.sets); const numeric = sets.filter((set) => Number.isFinite(Number(set.load)) && Number(set.load) > 0);
  if (numeric.length) return numeric.sort((left, right) => Number(right.load) - Number(left.load) || Number(right.reps) - Number(left.reps))[0];
  return sets.sort((left, right) => Number(right.reps) - Number(left.reps))[0];
}

function Progress({ sessions, history }: { sessions: CompletedWorkout[]; history: HistoryMap }) {
  const recent = sessionsInLastDays(sessions, 28); const timed = recent.filter((session) => session.sync.status !== "legacy").map(workoutDurationMinutes).filter((duration) => duration > 0);
  const average = timed.length ? Math.round(timed.reduce((sum, duration) => sum + duration, 0) / timed.length) : 0;
  const liftHistory = Object.entries(history).filter(([, saved]) => saved.length > 0);
  const milestones = liftMilestones(history).slice(0, 6);
  return <section className="progress" id="progress" aria-labelledby="progress-title"><div className="section-heading"><div><span className="eyebrow">Training record</span><h2 id="progress-title">Progress</h2></div><p>Facts from completed workouts—no streaks and no makeup debt.</p></div><div className="progress-grid"><article className="frequency-card"><span>Last 28 days</span><strong>{recent.length}</strong><p>completed workout{recent.length === 1 ? "" : "s"}{average ? ` · ${average} min average` : ""}</p><div>{WORKOUT_SEQUENCE.map((workout) => <span className={workout} key={workout}>{workout} <b>{recent.filter((session) => session.workout === workout).length}</b></span>)}</div></article><article className="bodyweight-card"><span>Bodyweight</span><BodyweightChart sessions={sessions} /></article></div>{milestones.length > 0 && <div className="milestones"><h3>Recent milestones</h3><div>{milestones.map((milestone) => <article key={`${milestone.exercise}-${milestone.date}-${milestone.kind}`}><span>{milestone.kind === "load" ? "New load" : "Rep record"}</span><strong>{milestone.exercise}</strong><p>{milestone.load || "BW"} × {milestone.reps}</p><time>{new Date(milestone.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time></article>)}</div></div>}<div className="lift-progress"><h3>Recent lifts</h3>{liftHistory.length ? <div className="lift-grid">{liftHistory.map(([name, saved]) => { const record = bestRecordedSet([...saved]); return <details key={name}><summary><span>{name}</span><strong>{record ? `${record.load || "BW"} × ${record.reps}` : "—"}<small>recorded best</small></strong></summary><ol>{saved.slice(0, 4).map((session) => <li key={session.id}><time>{new Date(session.savedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time><span>{formatSession(session)}</span></li>)}</ol></details>; })}</div> : <div className="empty-progress"><strong>No completed lifts yet.</strong><span>Finish a workout to begin the record.</span></div>}</div></section>;
}

function AutumnConnection({ settings, projects, status, busy, pending, onSettings, onSignIn, onTest, onLoad, onSync }: {
  settings: AutumnSettings; projects: AutumnProject[]; status: string; busy: boolean; onSettings: (settings: AutumnSettings) => void;
  pending: CompletedWorkout[]; onSignIn: (username: string, password: string) => Promise<void>; onTest: () => Promise<void>; onLoad: () => Promise<void>; onSync: (session: CompletedWorkout) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const submit = async (event: FormEvent) => { event.preventDefault(); await onSignIn(settings.username, password); setPassword(""); };
  return <section className="autumn-panel" id="autumn" aria-labelledby="autumn-title"><div className="section-heading"><div><span className="eyebrow">Optional connection</span><h2 id="autumn-title">Autumn sync</h2></div><p>Your password is never saved. The returned token stays only in this browser and is excluded from backups.</p></div><div className="autumn-layout"><form onSubmit={submit}><label><span>Username or email</span><input autoComplete="username" value={settings.username} onChange={(event) => onSettings({ ...settings, username: event.target.value })} /></label><label><span>Password</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label><button className="primary-action" type="submit" disabled={busy || !settings.username || !password}>{busy ? "Connecting…" : "Connect"}</button></form><div className="autumn-project"><label><span>Gym project</span><select value={settings.projectId ?? ""} disabled={!settings.token || busy} onChange={(event) => { const project = projects.find((item) => item.id === Number(event.target.value)); onSettings({ ...settings, projectId: project?.id, projectName: project?.name }); }}><option value="">Choose a project</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}{project.status === "active" ? " · active" : ""}</option>)}</select></label><div><button type="button" className="secondary-action" disabled={!settings.token || busy} onClick={onLoad}>Load projects</button><button type="button" className="text-action" disabled={!settings.token || busy} onClick={onTest}>Test connection</button></div><p className={status.toLowerCase().includes("failed") || status.toLowerCase().includes("choose") ? "error" : ""} role="status">{status || (settings.token ? "Connected token saved locally." : "Connect once, then choose the current gym project.")}</p></div></div>{pending.length > 0 && <div className="pending-sync"><h3>Waiting to sync <span>{pending.length}</span></h3>{pending.map((session) => <article key={session.id}><div><strong>{session.workout} · {new Date(session.endedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</strong><small>{session.sync.message || `Ready for ${session.sync.projectName || settings.projectName || "your gym project"}.`}</small><details><summary>Review Autumn note</summary><pre>{workoutSummary(session)}</pre></details></div><button type="button" disabled={busy} onClick={() => onSync(session)}>{session.sync.status === "error" ? "Retry" : "Sync"}</button></article>)}</div>}<details className="connection-advanced"><summary>Connection details</summary><label><span>Autumn URL</span><input type="url" value={settings.baseUrl} placeholder={DEFAULT_AUTUMN_URL} onChange={(event) => onSettings({ ...settings, baseUrl: event.target.value })} /></label><label><span>API token</span><input type="password" autoComplete="off" value={settings.token} placeholder="Paste a token instead of signing in" onChange={(event) => onSettings({ ...settings, token: event.target.value.trim() })} /></label></details></section>;
}

function Notes() {
  return <section className="notes" aria-labelledby="notes-title"><h2 id="notes-title">Rules you may need</h2><details><summary>What if I am short on time?</summary><p>Complete every exercise marked Must do when you can. If time runs out, finish normally and continue with the next workout next time. Nothing becomes debt.</p></details><details><summary>How to progress</summary><p>Add reps within the range while keeping about two clean reps in reserve. When every required work set reaches the top cleanly twice, add the smallest available weight. Optional sets count as work but never block required-set progression.</p></details><details><summary>How to warm up</summary><p>Spend 5–8 minutes raising body temperature. Then use progressively heavier, low-rep ramp sets before the first big lift. Ramp sets do not count as work sets.</p></details><details><summary>Why no shoulder press?</summary><p>Bench and incline press already train the front delts, while lateral raises cover the side delts. Leaving out another heavy press keeps fatigue lower so chest performance stays the priority.</p></details><details><summary>Safety and rest</summary><p>Use safeties or a spotter for bench and squat. Do not normalize joint pain. Controlled, repeatable technique matters more than load.</p></details></section>;
}

function Lightbox({ image, onClose }: { image: LightboxImage | null; onClose: () => void }) {
  useEffect(() => { if (!image) return; const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); }; const previousOverflow = document.body.style.overflow; document.body.style.overflow = "hidden"; window.addEventListener("keydown", onKeyDown); return () => { document.body.style.overflow = previousOverflow; window.removeEventListener("keydown", onKeyDown); }; }, [image, onClose]);
  if (!image) return null;
  return <div className="lightbox"><div className="lightbox-dialog" role="dialog" aria-modal="true" aria-label={image.alt}><button className="lightbox-close" type="button" onClick={onClose}>Close <span aria-hidden="true">×</span></button><img className="lightbox-image" src={image.src} alt={image.alt} /><p>{image.alt}</p></div></div>;
}

function App() {
  const initialHistory = useMemo(() => canonicalizeHistory(readStored<HistoryMap>(HISTORY_KEY, {})), []);
  const [history, setHistory] = useState<HistoryMap>(initialHistory);
  const [drafts, setDrafts] = useState<DraftMap>(() => pruneCompletedDrafts(readStored<DraftMap>(DRAFTS_KEY, {}), initialHistory));
  const [completed, setCompleted] = useState<CompletedWorkout[]>(() => { const stored = readStored<CompletedWorkout[]>(WORKOUTS_KEY, []); return stored.length ? stored : migrateLegacyHistory(initialHistory, exerciseWorkouts); });
  const [activeWorkout, setActiveWorkout] = useState<ActiveWorkout | null>(() => readStored<ActiveWorkout | null>(ACTIVE_WORKOUT_KEY, null));
  const [next, setNext] = useState<WorkoutKey>(() => { const stored = readStored<unknown>(NEXT_WORKOUT_KEY, ""); if (isWorkoutKey(stored)) return stored; const sessions = readStored<CompletedWorkout[]>(WORKOUTS_KEY, []); if (sessions[0] && isWorkoutKey(sessions[0].workout)) return followingWorkout(sessions[0].workout); const legacy = migrateLegacyHistory(initialHistory, exerciseWorkouts); return legacy[0] ? followingWorkout(legacy[0].workout) : "push"; });
  const [activeTab, setActiveTab] = useState<WorkoutKey>(() => activeWorkout?.workout ?? next);
  const [lightbox, setLightbox] = useState<LightboxImage | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [bodyweight, setBodyweight] = useState("");
  const [sessionNote, setSessionNote] = useState("");
  const [finishError, setFinishError] = useState("");
  const [now, setNow] = useState(0);
  const [importResult, setImportResult] = useState<ImportResult>(null);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [autumn, setAutumn] = useState<AutumnSettings>(() => ({ ...defaultAutumnSettings(), ...readStored<Partial<AutumnSettings>>(AUTUMN_KEY, {}) }));
  const [autumnProjects, setAutumnProjects] = useState<AutumnProject[]>([]);
  const [autumnStatus, setAutumnStatus] = useState("");
  const [autumnBusy, setAutumnBusy] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => { const saved = readStored<string>(THEME_KEY, ""); if (saved === "light" || saved === "dark") return saved; return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; });

  useEffect(() => storeLocal(HISTORY_KEY, history), [history]);
  useEffect(() => storeLocal(DRAFTS_KEY, drafts), [drafts]);
  useEffect(() => storeLocal(WORKOUTS_KEY, completed), [completed]);
  useEffect(() => storeLocal(ACTIVE_WORKOUT_KEY, activeWorkout), [activeWorkout]);
  useEffect(() => storeLocal(NEXT_WORKOUT_KEY, next), [next]);
  useEffect(() => storeLocal(AUTUMN_KEY, autumn), [autumn]);
  useEffect(() => { document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#171d24" : "#f2f4f6"); storeLocal(THEME_KEY, theme); }, [theme]);
  useEffect(() => { if (!activeWorkout) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, [activeWorkout]);
  useEffect(() => { const onPrompt = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPromptEvent); }; const onInstalled = () => setInstallPrompt(null); window.addEventListener("beforeinstallprompt", onPrompt); window.addEventListener("appinstalled", onInstalled); return () => { window.removeEventListener("beforeinstallprompt", onPrompt); window.removeEventListener("appinstalled", onInstalled); }; }, []);

  const installApp = async () => { if (!installPrompt) return; await installPrompt.prompt(); await installPrompt.userChoice; setInstallPrompt(null); };
  const updateDraft = (name: string, entries: SetEntry[]) => setDrafts((current) => ({ ...current, [name]: entries }));
  const startWorkout = () => { const active = createActiveWorkout(next); setActiveWorkout(active); setActiveTab(next); setNow(Date.now()); setFinishing(false); setFinishError(""); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const cancelWorkout = () => {
    if (!activeWorkout || !window.confirm("Cancel this workout and clear its entered sets?")) return;
    const names = new Set(workouts[activeWorkout.workout].exercises.map((exercise) => exercise.name));
    setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([name]) => !names.has(name)))); setActiveWorkout(null); setFinishing(false);
  };
  const saveFinishedWorkout = () => {
    if (!activeWorkout) return;
    const result = completeWorkout({ active: activeWorkout, definitions: workouts[activeWorkout.workout].exercises.map(({ name, priority, loadSuffix }) => ({ name, priority, loadSuffix })), drafts, bodyweight, note: sessionNote });
    if (!result.session) { setFinishError(result.error || "The workout could not be saved."); return; }
    const session = result.session;
    if (autumn.projectId && autumn.projectName) session.sync = { ...session.sync, projectId: autumn.projectId, projectName: autumn.projectName };
    setHistory((current) => addWorkoutToHistory(current, session)); setCompleted((current) => [session, ...current.filter((item) => item.id !== session.id)]);
    const names = new Set(workouts[session.workout].exercises.map((exercise) => exercise.name)); setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([name]) => !names.has(name))));
    const following = followingWorkout(session.workout); setNext(following); setActiveTab(following); setActiveWorkout(null); setFinishing(false); setBodyweight(""); setSessionNote(""); setFinishError(""); window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const chooseDefaultProject = (projects: AutumnProject[], current: AutumnSettings) => {
    const existing = projects.find((project) => project.id === current.projectId); if (existing) return { ...current, projectName: existing.name };
    const gym = projects.find((project) => project.status === "active" && /^Gym\s*-\s*/i.test(project.name)) ?? projects.find((project) => /^Gym\s*-\s*/i.test(project.name));
    return gym ? { ...current, projectId: gym.id, projectName: gym.name } : current;
  };
  const loadProjectsFor = async (settings: AutumnSettings) => { const projects = await listAutumnProjects(settings); setAutumnProjects(projects); setAutumn(chooseDefaultProject(projects, settings)); return projects; };
  const signIn = async (username: string, password: string) => {
    setAutumnBusy(true);
    try { const token = await signInToAutumn(autumn, username, password); const connected = { ...autumn, username, token }; setAutumn(connected); const projects = await loadProjectsFor(connected); setAutumnStatus(`Connected. Loaded ${projects.length} projects.`); }
    catch (error) { setAutumnStatus(`Connection failed: ${error instanceof Error ? error.message : "Unknown error"}`); }
    finally { setAutumnBusy(false); }
  };
  const loadProjects = async () => { setAutumnBusy(true); try { const projects = await loadProjectsFor(autumn); setAutumnStatus(`Loaded ${projects.length} projects.`); } catch (error) { setAutumnStatus(`Load failed: ${error instanceof Error ? error.message : "Unknown error"}`); } finally { setAutumnBusy(false); } };
  const testConnection = async () => { setAutumnBusy(true); try { const account = await getAutumnAccount(autumn); setAutumnStatus(`Connected as ${account}.`); } catch (error) { setAutumnStatus(`Connection failed: ${error instanceof Error ? error.message : "Unknown error"}`); } finally { setAutumnBusy(false); } };
  const updateCompleted = (id: string, update: (session: CompletedWorkout) => CompletedWorkout) => setCompleted((current) => current.map((session) => session.id === id ? update(session) : session));
  const syncWorkout = async (session: CompletedWorkout) => {
    const hasDestination = Boolean((session.sync.projectId && session.sync.projectName) || (autumn.projectId && autumn.projectName));
    if (!autumn.token || !hasDestination) { setAutumnStatus("Choose an Autumn connection and gym project before syncing."); document.getElementById("autumn")?.scrollIntoView({ behavior: "smooth" }); return; }
    setAutumnBusy(true); updateCompleted(session.id, (current) => ({ ...current, sync: { ...current.sync, status: "syncing", message: "Sending to Autumn…" } }));
    const destination = session.sync.projectId && session.sync.projectName ? { ...autumn, projectId: session.sync.projectId, projectName: session.sync.projectName } : autumn;
    try { const result = await pushWorkoutToAutumn(destination, session); updateCompleted(session.id, (current) => ({ ...current, sync: { status: "synced", projectId: destination.projectId, projectName: destination.projectName, autumnSessionId: result.id, syncedAt: new Date().toISOString() } })); setAutumnStatus(`Synced ${session.workout} to ${destination.projectName}.`); }
    catch (error) { const message = error instanceof Error ? error.message : "Unknown error"; updateCompleted(session.id, (current) => ({ ...current, sync: { ...current.sync, status: "error", message: `Sync failed: ${message}` } })); setAutumnStatus(`Sync failed: ${message}`); }
    finally { setAutumnBusy(false); }
  };

  const hasHistory = Object.values(history).some((sessions) => sessions.length > 0);
  const importHistory = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget; const file = input.files?.[0]; if (!file) return;
    try {
      const text = await file.text(); const parsed = file.name.toLowerCase().endsWith(".csv") ? { sessions: parseCsvSessions(text), workouts: [] as CompletedWorkout[] } : parseJsonBackup(text);
      setHistory((current) => { const nextHistory: HistoryMap = { ...current }; parsed.sessions.forEach((session) => { const restored = { id: session.sessionId, savedAt: session.performedAt, sets: session.sets.map(({ load, reps }) => ({ load, reps })) }; const byId = new Map((nextHistory[session.exercise] ?? []).map((saved) => [saved.id, saved])); byId.set(restored.id, restored); nextHistory[session.exercise] = Array.from(byId.values()).sort((left, right) => right.savedAt.localeCompare(left.savedAt)); }); return nextHistory; });
      if (parsed.workouts.length) setCompleted((current) => { const byId = new Map(current.map((session) => [session.id, session])); parsed.workouts.forEach((session) => byId.set(session.id, session)); return Array.from(byId.values()).sort((left, right) => right.endedAt.localeCompare(left.endedAt)); });
      setImportResult({ kind: "success", message: `Imported ${parsed.sessions.length} lift record${parsed.sessions.length === 1 ? "" : "s"}${parsed.workouts.length ? ` and ${parsed.workouts.length} workouts` : ""}.` });
    } catch (error) { setImportResult({ kind: "error", message: error instanceof Error ? error.message : "The file could not be read." }); }
    finally { input.value = ""; }
  };

  const latest = completed.find((session) => session.sync.status !== "legacy");
  const pending = completed.filter((session) => session.sync.status === "unsynced" || session.sync.status === "error" || session.sync.status === "syncing");
  return <>
    <header className="app-header"><div><h1>Rolling PPL</h1><p>Chest-prioritized · no weekly reset</p></div><div className="header-actions"><a href="#progress">Progress</a><a href="#autumn">Autumn</a><details className="export-menu"><summary aria-label="Export or import workout history">Data</summary><div className="export-panel"><span>Workout history</span><button type="button" disabled={!hasHistory} onClick={() => downloadHistory(history, completed, "json")}>JSON <small>Full backup</small></button><button type="button" disabled={!hasHistory} onClick={() => downloadHistory(history, completed, "csv")}>CSV <small>Spreadsheet</small></button><div className="export-separator" /><label className="import-button">Import <small>JSON or CSV</small><input className="file-input" type="file" accept=".json,.csv,application/json,text/csv" onChange={importHistory} /></label>{importResult && <p className={`import-result ${importResult.kind}`} role="status">{importResult.message}</p>}</div></details>{installPrompt && <button className="install-button" type="button" onClick={installApp}>Install</button>}<button className="theme-toggle" type="button" onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}><span aria-hidden="true">{theme === "dark" ? "☀" : "☾"}</span></button></div></header>
    <main>
      <TrainingRail next={next} active={activeWorkout} now={now} finishing={finishing} latest={latest} syncBusy={autumnBusy} onSetNext={(workout) => { setNext(workout); setActiveTab(workout); }} onStart={startWorkout} onFinish={() => setFinishing(true)} onCancel={cancelWorkout} onSync={syncWorkout} />
      {finishing && activeWorkout && <FinishWorkout workout={activeWorkout.workout} bodyweight={bodyweight} note={sessionNote} error={finishError} onBodyweight={setBodyweight} onNote={setSessionNote} onBack={() => { setFinishing(false); setFinishError(""); }} onSave={saveFinishedWorkout} />}
      <div className="workout-tabs" role="tablist" aria-label="Choose a workout to view">{WORKOUT_SEQUENCE.map((key) => <button key={key} role="tab" aria-selected={activeTab === key} className={activeTab === key ? `active ${key}` : ""} onClick={() => setActiveTab(key)}>{key}<small>{activeWorkout?.workout === key ? "logging now" : `${workouts[key].exercises.length} exercises`}</small></button>)}</div>
      <p className="storage-note">Sets autosave on this device. Finish once; sync to Autumn when ready.</p>
      <Workout workout={activeTab} onOpen={setLightbox} history={history} drafts={drafts} enabled={activeWorkout?.workout === activeTab && !finishing} onDraftChange={updateDraft} />
      <Progress sessions={completed} history={history} />
      <AutumnConnection settings={autumn} projects={autumnProjects} status={autumnStatus} busy={autumnBusy} pending={pending} onSettings={setAutumn} onSignIn={signIn} onTest={testConnection} onLoad={loadProjects} onSync={syncWorkout} />
      <Notes />
    </main>
    <footer><p><strong>Rolling PPL</strong> · Keep the sequence; skip the weekly reset.</p><p>Exercise imagery from the public-domain <a href="https://github.com/yuhonas/free-exercise-db" target="_blank" rel="noreferrer">Free Exercise DB</a> (Unlicense).</p></footer>
    <Lightbox image={lightbox} onClose={() => setLightbox(null)} />
  </>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

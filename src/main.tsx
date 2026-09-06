import { Fragment, StrictMode, useEffect, useMemo, useState, useSyncExternalStore, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  DEFAULT_AUTUMN_URL, defaultAutumnSettings, getAutumnAccount, listAutumnProjects,
  pushWorkoutToAutumn, signInToAutumn, type AutumnProject, type AutumnSettings,
} from "./autumn";
import { TrendChart } from "./TrendChart";
import { SessionHistory } from "./SessionHistory";
import { DataMenu } from "./DataMenu";
import { PeerSyncPanel } from "./PeerSyncPanel";
import { PeerSyncManager } from "./peerSyncManager";
import type { SyncSnapshot } from "./peerSyncModel";
import { parseBackupText } from "./transfer";
import { pruneCompletedDrafts, type DraftMap } from "./drafts";
import { canonicalizeHistory, type HistoryMap, type SavedSession, type SetEntry } from "./historyMigration";
import { nextStep, setTarget } from "./progression";
import { availableChartExercises, bodyweightSeries, exerciseMetricSeries } from "./progressModel";
import {
  WORKOUT_SEQUENCE, addWorkoutToHistory, completeWorkout, createActiveWorkout, elapsedLabel, liftMilestones,
  migrateLegacyHistory, nextWorkout as followingWorkout, selectedExerciseSets, sessionsInLastDays, workoutDurationMinutes,
  workoutSummary, type ActiveWorkout, type CompletedWorkout, type WorkoutKey,
} from "./sessionModel";
import "./styles.css";

type Theme = "light" | "dark";
type AppView = "train" | "sessions" | "progress";
type Demo = { label: string; slug: string };
type Exercise = {
  name: string; sets: string; reps: string; rest: string; warmup: string; cue: string;
  priority: "must" | "optional"; loadSuffix?: string; demos: Demo[];
};
type LightboxImage = { src: string; alt: string };
type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

const HISTORY_KEY = "rolling-ppl-history-v1";
const DRAFTS_KEY = "rolling-ppl-drafts-v1";
const THEME_KEY = "rolling-ppl-theme-v1";
const WORKOUTS_KEY = "rolling-ppl-workouts-v2";
const ACTIVE_WORKOUT_KEY = "rolling-ppl-active-workout-v2";
const NEXT_WORKOUT_KEY = "rolling-ppl-next-workout-v1";
const AUTUMN_KEY = "rolling-ppl-autumn-v1";
const APP_VIEW_KEY = "rolling-ppl-app-view-v1";
const VOLUME_EXERCISES_KEY = "rolling-ppl-volume-exercises-v1";
const LOAD_EXERCISES_KEY = "rolling-ppl-load-exercises-v1";
const CHECKPOINTS_KEY = "rolling-ppl-exercise-checkpoints-v1";

type ExerciseCheckpoint = { workoutId: string; fingerprint: string };
type CheckpointMap = Record<string, ExerciseCheckpoint>;
type SaveResult = { ok: boolean; message: string };
type FinishSummary = { exerciseCount: number; exerciseTotal: number; setCount: number; missingMust: string[]; unsaved: string[] };

function readStored<T>(key: string, fallback: T): T {
  const value = localStorage.getItem(key);
  if (value === null) return fallback;
  try { return JSON.parse(value) as T; }
  catch { return typeof fallback === "string" ? value as T : fallback; }
}

function storeLocal(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}

function exerciseFingerprint(entries: SetEntry[]) {
  const result = selectedExerciseSets(entries);
  return result.error || !result.sets.length ? "" : JSON.stringify(result.sets.map(({ load, reps }) => ({ load, reps })));
}

function isWorkoutKey(value: unknown): value is WorkoutKey { return value === "push" || value === "pull" || value === "legs"; }

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

const sessionDefinitions = Object.fromEntries(WORKOUT_SEQUENCE.map((key) => [key, workouts[key].exercises]));

function DemoStrip({ demo, exercise, onOpen }: { demo: Demo; exercise: string; onOpen: (image: LightboxImage) => void }) {
  const poses = [{ src: `./exercises/${demo.slug}-0.jpg`, alt: `${demo.label}: first position` }, { src: `./exercises/${demo.slug}-1.jpg`, alt: `${demo.label}: second position` }];
  return <figure className="demo-strip"><div className="poses"><button className="image-button" type="button" onClick={() => onOpen(poses[0])} aria-label={`Enlarge ${poses[0].alt}`}><img src={poses[0].src} alt={poses[0].alt} loading="lazy" /></button><span aria-hidden="true">→</span><button className="image-button" type="button" onClick={() => onOpen(poses[1])} aria-label={`Enlarge ${poses[1].alt}`}><img src={poses[1].src} alt={poses[1].alt} loading="lazy" /></button></div><figcaption>{demo.label}</figcaption><a className="image-source" href="https://github.com/yuhonas/free-exercise-db" target="_blank" rel="noreferrer" aria-label={`Public-domain image source for ${exercise}`}>source</a></figure>;
}

function WorkoutClock({ startedAt, endedAt }: { startedAt: string; endedAt?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (endedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [endedAt]);
  const label = elapsedLabel(startedAt, endedAt ? Date.parse(endedAt) : now);
  return <strong aria-label={`Elapsed time ${label}`}>{label}</strong>;
}

function TrainingRail({ next, active, finishEndedAt, finishing, latest, syncBusy, onSetNext, onStart, onFinish, onCancel, onSync }: {
  next: WorkoutKey; active: ActiveWorkout | null; finishEndedAt?: string; finishing: boolean; latest?: CompletedWorkout; syncBusy: boolean;
  onSetNext: (workout: WorkoutKey) => void; onStart: () => void; onFinish: () => void; onCancel: () => void; onSync: (session: CompletedWorkout) => void;
}) {
  const workout = active?.workout ?? next;

  return <section className={`training-rail ${workout}`} aria-labelledby="training-title">
    <div className="rail-main">
      <div className="rail-copy"><span className="eyebrow">{active ? "Workout in progress" : "Next workout"}</span><h2 id="training-title">{workout}</h2><p>{active ? `Started ${new Date(active.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "The sequence moves only when you finish."}</p></div>
      {active ? <div className="rail-live"><WorkoutClock startedAt={active.startedAt} endedAt={finishEndedAt} /><button className="primary-action" type="button" onClick={onFinish} disabled={finishing}>Finish workout</button><button className="text-action" type="button" onClick={onCancel}>Cancel</button></div>
        : <div className="rail-start"><div className="sequence-dots" aria-label="Push, Pull, Legs sequence">{WORKOUT_SEQUENCE.map((item) => <span key={item} className={item === next ? "current" : ""}>{item}</span>)}</div><button className="primary-action" type="button" onClick={onStart}>Start {next}</button><details className="next-picker"><summary>Change next</summary><div>{WORKOUT_SEQUENCE.map((item) => <button type="button" key={item} onClick={() => onSetNext(item)}>{item}</button>)}</div></details></div>}
    </div>
    {!active && latest && latest.sync.status !== "legacy" && <div className={`sync-receipt ${latest.sync.status}`}><div><span>{latest.sync.status === "synced" ? "Autumn receipt" : "Saved on this device"}</span><strong>{latest.workout[0].toUpperCase() + latest.workout.slice(1)} · {workoutDurationMinutes(latest)} min</strong><small>{latest.sync.status === "synced" ? `Synced to ${latest.sync.projectName}` : latest.sync.message || "Ready to sync when you are."}</small></div>{latest.sync.status !== "synced" ? <button type="button" disabled={syncBusy} onClick={() => onSync(latest)}>{syncBusy ? "Syncing…" : "Sync to Autumn"}</button> : <b aria-label="Synced">✓</b>}</div>}
  </section>;
}

function FinishWorkout({ workout, bodyweight, note, error, summary, onBodyweight, onNote, onBack, onSave }: {
  workout: WorkoutKey; bodyweight: string; note: string; error: string; summary: FinishSummary; onBodyweight: (value: string) => void; onNote: (value: string) => void; onBack: () => void; onSave: () => void;
}) {
  const warnings = [...(summary.missingMust.length ? [`No sets entered for ${summary.missingMust.join(", ")}.`] : []), ...(summary.unsaved.length ? [`Unchecked changes in ${summary.unsaved.join(", ")}.`] : [])];
  return <section className="finish-panel" aria-labelledby="finish-title"><div><span className="eyebrow">Finish {workout}</span><h2 id="finish-title">Close the session</h2><p>Review what the app detected before saving and advancing.</p><div className="finish-summary"><strong>{summary.exerciseCount} of {summary.exerciseTotal} exercises</strong><span>{summary.setCount} work set{summary.setCount === 1 ? "" : "s"}</span></div>{warnings.length > 0 && <div className="finish-warning" role="status">{warnings.map((warning) => <p key={warning}>{warning}</p>)}<small>A shortened workout is allowed. Save only if this count is right.</small></div>}</div><div className="finish-fields"><label><span>Bodyweight</span><div><input value={bodyweight} onChange={(event) => onBodyweight(event.target.value)} inputMode="decimal" placeholder="64.6" /><small>kg</small></div></label><label><span>Session note</span><textarea value={note} onChange={(event) => onNote(event.target.value)} rows={3} placeholder="How it felt, anything unusual…" /></label></div>{error && <p className="form-error" role="alert">{error}</p>}<div className="finish-actions"><button type="button" className="primary-action" onClick={onSave}>Save workout</button><button type="button" className="secondary-action" onClick={onBack}>Keep training</button></div></section>;
}

function ExerciseRow({ exercise, index, onOpen, history, draft, enabled, checked, onDraftChange, onSave }: {
  exercise: Exercise; index: number; onOpen: (image: LightboxImage) => void; history: SavedSession[]; draft: SetEntry[]; enabled: boolean; checked: boolean; onDraftChange: (entries: SetEntry[]) => void; onSave: (entries: SetEntry[]) => SaveResult;
}) {
  const [message, setMessage] = useState("");
  const range = setRange(exercise.sets);
  const entries = Array.from({ length: range.max }, (_, setIndex) => draft[setIndex] ?? { load: "", reps: "" });
  const previous = history[0];
  const updateEntry = (setIndex: number, field: keyof SetEntry, value: string) => { onDraftChange(entries.map((entry, entryIndex) => entryIndex === setIndex ? { ...entry, [field]: value } : entry)); setMessage(checked ? "Unsaved changes." : ""); };
  const save = () => { const result = onSave(entries); setMessage(result.message); };
  return <article className={`exercise-row ${exercise.priority} ${enabled ? "logging" : "reference"}`}>
    <div className={`demo-grid ${exercise.demos.length > 1 ? "has-options" : ""}`}>{exercise.demos.map((demo) => <DemoStrip key={demo.slug} demo={demo} exercise={exercise.name} onOpen={onOpen} />)}</div>
    <div className="exercise-info"><div className="exercise-title"><span>{index + 1}</span><h3>{exercise.name}</h3><strong className={`priority-badge ${exercise.priority}`}>{exercise.priority === "must" ? "Must do" : "If time"}</strong></div><div className="prescription"><strong>{exercise.sets}</strong><small>sets</small><i>×</i><strong>{exercise.reps}</strong><small>reps</small></div><p className="cue">{exercise.cue}</p><div className="exercise-meta"><span>Optional warm-up: {exercise.warmup}</span><span>Rest: {exercise.rest}</span><span>Start around 2 RIR</span></div>
      <section className={`set-tracker ${checked ? "checked" : ""}`} aria-label={`Progressive overload log for ${exercise.name}`}><div className="tracker-heading"><div><h4>{enabled ? "Log work sets" : "Today's targets"}</h4><p>{enabled ? "Entries recover automatically. Check each exercise when done." : "Start this workout to enter sets."}</p></div>{previous && <div className="previous-session"><span>Previous</span><strong>{formatSession(previous)}</strong></div>}</div><div className="set-entries">{entries.map((entry, setIndex) => { const target = setTarget(exercise.reps, history, setIndex, range.min); return <div className="set-entry" key={setIndex}><div className="set-number">Set {setIndex + 1}{setIndex >= range.min && <small>optional</small>}</div><label><span>Load{target && <em>Target {target.load}</em>}</span><input disabled={!enabled} value={entry.load} onChange={(event) => updateEntry(setIndex, "load", event.target.value)} inputMode="decimal" maxLength={12} placeholder="kg / BW" aria-label={`${exercise.name} set ${setIndex + 1} load${target ? `, target ${target.load}` : ""}`} /></label><label><span>Reps{target && <em>Target {target.reps}</em>}</span><input disabled={!enabled} value={entry.reps} onChange={(event) => updateEntry(setIndex, "reps", event.target.value)} type="number" inputMode="numeric" min="0" max="99" placeholder="reps" aria-label={`${exercise.name} set ${setIndex + 1} reps${target ? `, target ${target.reps}` : ""}`} /></label></div>; })}</div><div className="next-step"><span>Next target</span><strong>{nextStep(exercise.reps, history, range.min)}</strong></div>{enabled && <div className="tracker-actions"><button type="button" className={checked ? "checked" : ""} onClick={save}>{checked ? "Saved ✓" : "Save exercise"}</button><p className={checked && !message.startsWith("Unsaved") ? "save-message success" : "save-message"} aria-live="polite">{message || (checked ? "Checked and saved on this device." : "")}</p></div>}{history.length > 0 && <details className="history"><summary>History ({history.length})</summary><ol>{history.slice(0, 5).map((session) => <li key={session.id}><time dateTime={session.savedAt}>{new Date(session.savedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time><span>{formatSession(session)}</span></li>)}</ol></details>}</section>
    </div>
  </article>;
}

function Workout({ workout, onOpen, history, drafts, enabled, activeWorkoutId, checkpoints, onDraftChange, onSave }: { workout: WorkoutKey; onOpen: (image: LightboxImage) => void; history: HistoryMap; drafts: DraftMap; enabled: boolean; activeWorkoutId?: string; checkpoints: CheckpointMap; onDraftChange: (name: string, entries: SetEntry[]) => void; onSave: (name: string, entries: SetEntry[]) => SaveResult }) {
  const data = workouts[workout]; const mustDoCount = data.exercises.filter((exercise) => exercise.priority === "must").length; const optionalCount = data.exercises.length - mustDoCount;
  return <section className={`workout ${workout}`} aria-labelledby={`${workout}-title`}><header className="workout-header"><div><h2 id={`${workout}-title`}>{workout}</h2><p>{data.summary}</p></div><span>{mustDoCount} must · {optionalCount} if time</span></header><p className="short-session"><strong>Minimum version:</strong> complete every Must do card when you can. A shortened session still advances the sequence.</p><div className="exercise-list">{data.exercises.map((exercise, index) => { const checked = Boolean(activeWorkoutId && checkpoints[exercise.name]?.workoutId === activeWorkoutId && checkpoints[exercise.name]?.fingerprint === exerciseFingerprint(drafts[exercise.name] ?? [])); return <Fragment key={exercise.name}>{index === mustDoCount && <div className="optional-divider"><span>If time</span><p>Useful additions, already ranked. Stop whenever you need to.</p></div>}<ExerciseRow exercise={exercise} index={index} onOpen={onOpen} history={history[exercise.name] ?? []} draft={drafts[exercise.name] ?? []} enabled={enabled} checked={checked} onDraftChange={(entries) => onDraftChange(exercise.name, entries)} onSave={(entries) => onSave(exercise.name, entries)} /></Fragment>; })}</div></section>;
}

function ExercisePicker({ available, selected, onChange }: { available: string[]; selected: string[]; onChange: (selected: string[]) => void }) {
  const toggle = (exercise: string) => onChange(selected.includes(exercise) ? selected.filter((item) => item !== exercise) : [...selected, exercise]);
  const close = (event: MouseEvent<HTMLButtonElement>) => { const picker = event.currentTarget.closest("details"); if (picker instanceof HTMLDetailsElement) picker.open = false; };
  return <details className="exercise-picker"><summary>{selected.length ? `${selected.length} exercise${selected.length === 1 ? "" : "s"}` : "Choose exercises"}</summary><div><header><span>Lines to show · up to 6</span><div className="picker-actions"><button type="button" onClick={() => onChange([])}>Clear</button><button className="picker-done" type="button" onClick={close}>Done</button></div></header>{available.map((exercise) => { const checked = selected.includes(exercise); return <label key={exercise}><input type="checkbox" checked={checked} disabled={!checked && selected.length >= 6} onChange={() => toggle(exercise)} /><span>{exercise}</span></label>; })}</div></details>;
}

function BodyweightChart({ sessions }: { sessions: CompletedWorkout[] }) {
  const readings = useMemo(() => bodyweightSeries(sessions), [sessions]);
  const series = readings.length ? [{ exercise: "Bodyweight", points: readings }] : [];
  return <article className="chart-card bodyweight-chart-card"><div className="chart-card-heading"><div><h3>Bodyweight</h3><p>Your last 24 recorded weigh-ins.</p></div><span className="chart-context">Across sessions</span></div><TrendChart series={series} unit="kg" emptyTitle="No bodyweight readings yet." emptyHint="Add bodyweight when finishing or editing a session." label={`Bodyweight chart with ${readings.length} readings`} /></article>;
}

function ExerciseChart({ title, description, metric, history, storageKey }: { title: string; description: string; metric: "volume" | "load"; history: HistoryMap; storageKey: string }) {
  const available = useMemo(() => availableChartExercises(history), [history]);
  const [selected, setSelected] = useState<string[]>(() => {
    const hasStoredChoice = localStorage.getItem(storageKey) !== null; const stored = readStored<string[]>(storageKey, []); const valid = stored.filter((exercise) => available.includes(exercise)).slice(0, 6);
    if (hasStoredChoice) return valid;
    const bench = available.find((exercise) => exercise === "Barbell bench press"); return (bench ? [bench] : available.slice(0, 1));
  });
  const visible = selected.filter((exercise) => available.includes(exercise));
  useEffect(() => { storeLocal(storageKey, selected); }, [selected, storageKey]);
  const series = exerciseMetricSeries(history, visible, metric);
  const unit = metric === "volume" ? "kg·reps" : "kg";
  return <article className={`chart-card exercise-chart-card metric-${metric}`}><div className="chart-card-heading"><div><h3>{title}</h3><p>{description}</p></div><ExercisePicker available={available} selected={visible} onChange={setSelected} /></div><TrendChart series={series} unit={unit} emptyTitle={visible.length ? "No numeric loads for this selection." : "Choose an exercise to draw the line."} emptyHint={visible.length ? "Loads recorded as BW or text cannot be plotted in kilograms." : "Use the exercise picker above."} label={`${title} chart for ${visible.join(", ") || "no selected exercises"}`} />{metric === "volume" && <p className="chart-footnote">Recorded-load volume uses load × reps. Dumbbell values remain per dumbbell; BW and text loads are excluded.</p>}</article>;
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
  return <section className="progress" aria-labelledby="progress-title"><div className="section-heading progress-heading"><div><h2 id="progress-title">Progress</h2></div><p>See how your training is changing.</p></div><BodyweightChart sessions={sessions} /><div className="metric-chart-grid"><ExerciseChart title="Training volume" description="Recorded load × reps in each session. Last 16 sessions per lift." metric="volume" history={history} storageKey={VOLUME_EXERCISES_KEY} /><ExerciseChart title="Working weight" description="Your heaviest completed set. Last 16 sessions per lift." metric="load" history={history} storageKey={LOAD_EXERCISES_KEY} /></div><div className="progress-support"><article className="frequency-card"><span>Last 28 days</span><strong>{recent.length}</strong><p>completed workout{recent.length === 1 ? "" : "s"}{average ? ` · ${average} min average` : ""}</p><div>{WORKOUT_SEQUENCE.map((workout) => <span className={workout} key={workout}>{workout} <b>{recent.filter((session) => session.workout === workout).length}</b></span>)}</div></article>{milestones.length > 0 && <div className="milestones"><h3>Recent milestones</h3><div>{milestones.map((milestone) => <article key={`${milestone.exercise}-${milestone.date}-${milestone.kind}`}><span>{milestone.kind === "load" ? "New load" : "Rep record"}</span><strong>{milestone.exercise}</strong><p>{milestone.load || "BW"} × {milestone.reps}</p><time>{new Date(milestone.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time></article>)}</div></div>}</div><div className="lift-progress"><h3>Recent lifts</h3>{liftHistory.length ? <div className="lift-grid">{liftHistory.map(([name, saved]) => { const record = bestRecordedSet(saved); return <details key={name}><summary><span>{name}</span><strong>{record ? `${record.load || "BW"} × ${record.reps}` : "—"}<small>recorded best</small></strong></summary><ol>{saved.slice(0, 4).map((session) => <li key={session.id}><time>{new Date(session.savedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time><span>{formatSession(session)}</span></li>)}</ol></details>; })}</div> : <div className="empty-progress"><strong>No completed lifts yet.</strong><span>Finish a workout to begin the record.</span></div>}</div></section>;
}

function AutumnConnection({ settings, projects, status, busy, pending, onSettings, onSignIn, onTest, onLoad, onSync }: {
  settings: AutumnSettings; projects: AutumnProject[]; status: string; busy: boolean; onSettings: (settings: AutumnSettings) => void;
  pending: CompletedWorkout[]; onSignIn: (username: string, password: string) => Promise<void>; onTest: () => Promise<void>; onLoad: () => Promise<void>; onSync: (session: CompletedWorkout) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const submit = async (event: FormEvent) => { event.preventDefault(); await onSignIn(settings.username, password); setPassword(""); };
  return <section className="autumn-panel" aria-labelledby="autumn-title"><div className="section-heading"><div><span className="eyebrow">Optional connection</span><h2 id="autumn-title">Autumn sync</h2></div><p>Your password is never saved. The returned token stays only in this browser and is excluded from backups.</p></div><div className="autumn-layout"><form onSubmit={submit}><label><span>Username or email</span><input autoComplete="username" value={settings.username} onChange={(event) => onSettings({ ...settings, username: event.target.value })} /></label><label><span>Password</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label><button className="primary-action" type="submit" disabled={busy || !settings.username || !password}>{busy ? "Connecting…" : "Connect"}</button></form><div className="autumn-project"><label><span>Gym project</span><select value={settings.projectId ?? ""} disabled={!settings.token || busy} onChange={(event) => { const project = projects.find((item) => item.id === Number(event.target.value)); onSettings({ ...settings, projectId: project?.id, projectName: project?.name }); }}><option value="">Choose a project</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}{project.status === "active" ? " · active" : ""}</option>)}</select></label><div><button type="button" className="secondary-action" disabled={!settings.token || busy} onClick={onLoad}>Load projects</button><button type="button" className="text-action" disabled={!settings.token || busy} onClick={onTest}>Test connection</button></div><p className={status.toLowerCase().includes("failed") || status.toLowerCase().includes("choose") ? "error" : ""} role="status">{status || (settings.token ? "Connected token saved locally." : "Connect once, then choose the current gym project.")}</p></div></div>{pending.length > 0 && <div className="pending-sync"><h3>Waiting to sync <span>{pending.length}</span></h3>{pending.map((session) => <article key={session.id}><div><strong>{session.workout} · {new Date(session.endedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</strong><small>{session.sync.message || `Ready for ${session.sync.projectName || settings.projectName || "your gym project"}.`}</small><details><summary>Review Autumn note</summary><pre>{workoutSummary(session)}</pre></details></div><button type="button" disabled={busy} onClick={() => onSync(session)}>{session.sync.status === "error" ? "Retry" : "Sync"}</button></article>)}</div>}<details className="connection-advanced"><summary>Connection details</summary><label><span>Autumn URL</span><input type="url" value={settings.baseUrl} placeholder={DEFAULT_AUTUMN_URL} onChange={(event) => onSettings({ ...settings, baseUrl: event.target.value })} /></label><label><span>API token</span><input type="password" autoComplete="off" value={settings.token} placeholder="Paste a token instead of signing in" onChange={(event) => onSettings({ ...settings, token: event.target.value.trim() })} /></label></details></section>;
}

function AutumnModal({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.body.style.overflow = "hidden"; window.addEventListener("keydown", onKeyDown);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener("keydown", onKeyDown); };
  }, [open, onClose]);
  if (!open) return null;
  return <div className="modal-backdrop"><button className="modal-scrim" type="button" aria-label="Close Autumn settings" onClick={onClose} /><div className="autumn-dialog" role="dialog" aria-modal="true" aria-labelledby="autumn-title"><button className="modal-close" type="button" onClick={onClose}>Close <span aria-hidden="true">×</span></button>{children}</div></div>;
}

function Notes() {
  return <section className="notes" aria-labelledby="notes-title"><h2 id="notes-title">Rules you may need</h2><details><summary>What if I am short on time?</summary><p>Complete every exercise marked Must do when you can. If time runs out, finish normally and continue with the next workout next time. Nothing becomes debt.</p></details><details><summary>How to progress</summary><p>Add reps within the range while keeping about two clean reps in reserve. When every required work set reaches the top cleanly twice, add the smallest available weight. Optional sets count as work but never block required-set progression.</p></details><details><summary>How to warm up</summary><p>Spend 5–8 minutes raising body temperature. Then use progressively heavier, low-rep ramp sets before the first big lift. Ramp sets do not count as work sets.</p></details><details><summary>Why no shoulder press?</summary><p>Bench and incline press already train the front delts, while lateral raises cover the side delts. Leaving out another heavy press keeps fatigue lower so chest performance stays the priority.</p></details><details><summary>Safety and rest</summary><p>Use safeties or a spotter for bench and squat. Do not normalize joint pain. Controlled, repeatable technique matters more than load.</p></details></section>;
}

function Lightbox({ image, onClose }: { image: LightboxImage | null; onClose: () => void }) {
  useEffect(() => { if (!image) return; const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); }; const previousOverflow = document.body.style.overflow; document.body.style.overflow = "hidden"; window.addEventListener("keydown", onKeyDown); return () => { document.body.style.overflow = previousOverflow; window.removeEventListener("keydown", onKeyDown); }; }, [image, onClose]);
  if (!image) return null;
  return <div className="lightbox"><div className="lightbox-dialog" role="dialog" aria-modal="true" aria-label={image.alt}><button className="lightbox-close" type="button" onClick={onClose}>Close <span aria-hidden="true">×</span></button><img className="lightbox-image" src={image.src} alt={image.alt} /><p>{image.alt}</p></div></div>;
}

function bindField<K extends keyof SyncSnapshot>(manager: PeerSyncManager, key: K) {
  return (action: SyncSnapshot[K] | ((previous: SyncSnapshot[K]) => SyncSnapshot[K])) => manager.set(key, action);
}

function App({ manager }: { manager: PeerSyncManager }) {
  const { history, drafts, checkpoints, completed, activeWorkout, next, bodyweight, sessionNote } = useSyncExternalStore(manager.subscribe, manager.getSnapshot);
  const setDrafts = bindField(manager, "drafts");
  const setCheckpoints = bindField(manager, "checkpoints");
  const setCompleted = bindField(manager, "completed");
  const setActiveWorkout = bindField(manager, "activeWorkout");
  const setNext = bindField(manager, "next");
  const setBodyweight = bindField(manager, "bodyweight");
  const setSessionNote = bindField(manager, "sessionNote");
  const [activeTab, setActiveTab] = useState<WorkoutKey>(() => activeWorkout?.workout ?? next);
  const [appView, setAppView] = useState<AppView>(() => (value => value === "progress" || value === "sessions" ? value : "train")(readStored<AppView>(APP_VIEW_KEY, "train")));
  const [lightbox, setLightbox] = useState<LightboxImage | null>(null);
  const [autumnOpen, setAutumnOpen] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [finishEndedAt, setFinishEndedAt] = useState<string | null>(null);
  const [finishError, setFinishError] = useState("");
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [autumn, setAutumn] = useState<AutumnSettings>(() => ({ ...defaultAutumnSettings(), ...readStored<Partial<AutumnSettings>>(AUTUMN_KEY, {}) }));
  const [autumnProjects, setAutumnProjects] = useState<AutumnProject[]>([]);
  const [autumnStatus, setAutumnStatus] = useState("");
  const [autumnBusy, setAutumnBusy] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => { const saved = readStored<string>(THEME_KEY, ""); if (saved === "light" || saved === "dark") return saved; return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; });

  useEffect(() => { storeLocal(HISTORY_KEY, history); }, [history]);
  useEffect(() => { storeLocal(DRAFTS_KEY, drafts); }, [drafts]);
  useEffect(() => { storeLocal(CHECKPOINTS_KEY, checkpoints); }, [checkpoints]);
  useEffect(() => { storeLocal(WORKOUTS_KEY, completed); }, [completed]);
  useEffect(() => { storeLocal(ACTIVE_WORKOUT_KEY, activeWorkout); }, [activeWorkout]);
  useEffect(() => { storeLocal(NEXT_WORKOUT_KEY, next); }, [next]);
  useEffect(() => { storeLocal(APP_VIEW_KEY, appView); }, [appView]);
  useEffect(() => { storeLocal(AUTUMN_KEY, autumn); }, [autumn]);
  useEffect(() => {
    let previous = manager.getSnapshot();
    return manager.subscribe(() => {
      const current = manager.getSnapshot();
      if (current.next !== previous.next || current.activeWorkout?.id !== previous.activeWorkout?.id) {
        setActiveTab(current.activeWorkout?.workout ?? current.next);
        if (!current.activeWorkout) { setFinishing(false); setFinishEndedAt(null); }
      }
      previous = current;
    });
  }, [manager]);
  useEffect(() => { document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#171d24" : "#f2f4f6"); storeLocal(THEME_KEY, theme); }, [theme]);
  useEffect(() => { const onPrompt = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPromptEvent); }; const onInstalled = () => setInstallPrompt(null); window.addEventListener("beforeinstallprompt", onPrompt); window.addEventListener("appinstalled", onInstalled); return () => { window.removeEventListener("beforeinstallprompt", onPrompt); window.removeEventListener("appinstalled", onInstalled); }; }, []);

  const saveSessionEdit = (original: CompletedWorkout, updated: CompletedWorkout) => {
    const snapshot = manager.getSnapshot();
    const current = snapshot.completed.find((session) => session.id === original.id);
    if (JSON.stringify(current) !== JSON.stringify(original)) return "This session changed on another device. Cancel editing and reopen it to use the latest record.";
    try {
      manager.change({ ...snapshot, completed: snapshot.completed.map((session) => session.id === updated.id ? updated : session) });
      return "";
    } catch (error) { return error instanceof Error ? error.message : "Unable to save changes."; }
  };

  const installApp = async () => { if (!installPrompt) return; await installPrompt.prompt(); await installPrompt.userChoice; setInstallPrompt(null); };
  const updateDraft = (name: string, entries: SetEntry[]) => setDrafts((current) => ({ ...current, [name]: entries }));
  const saveExercise = (name: string, entries: SetEntry[]): SaveResult => {
    if (!activeWorkout) return { ok: false, message: "Start this workout before saving." };
    const result = selectedExerciseSets(entries);
    if (result.error) return { ok: false, message: result.error };
    if (!result.sets.length) return { ok: false, message: "Enter at least one completed set." };
    const nextDrafts = { ...drafts, [name]: entries };
    const nextCheckpoints = { ...checkpoints, [name]: { workoutId: activeWorkout.id, fingerprint: exerciseFingerprint(entries) } };
    if (!storeLocal(DRAFTS_KEY, nextDrafts) || !storeLocal(CHECKPOINTS_KEY, nextCheckpoints)) return { ok: false, message: "This device could not save the exercise. Keep this page open and try again." };
    setCheckpoints(nextCheckpoints);
    return { ok: true, message: "Checked and saved on this device." };
  };
  const startWorkout = () => { const active = createActiveWorkout(next); setActiveWorkout(active); setActiveTab(next); setAppView("train"); setFinishing(false); setFinishEndedAt(null); setFinishError(""); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const cancelWorkout = () => {
    if (!activeWorkout || !window.confirm("Cancel this workout and clear its entered sets?")) return;
    const names = new Set(workouts[activeWorkout.workout].exercises.map((exercise) => exercise.name));
    manager.change({ ...manager.getSnapshot(), drafts: Object.fromEntries(Object.entries(drafts).filter(([name]) => !names.has(name))), checkpoints: Object.fromEntries(Object.entries(checkpoints).filter(([name]) => !names.has(name))), activeWorkout: null, bodyweight: "", sessionNote: "" }); setFinishing(false); setFinishEndedAt(null);
  };
  const saveFinishedWorkout = () => {
    if (!activeWorkout) return;
    const result = completeWorkout({ active: activeWorkout, definitions: workouts[activeWorkout.workout].exercises.map(({ name, priority, loadSuffix }) => ({ name, priority, loadSuffix })), drafts, bodyweight, note: sessionNote, endedAt: finishEndedAt ?? new Date().toISOString() });
    if (!result.session) { setFinishError(result.error || "The workout could not be saved."); return; }
    const session = result.session;
    if (autumn.projectId && autumn.projectName) session.sync = { ...session.sync, projectId: autumn.projectId, projectName: autumn.projectName };
    const names = new Set(workouts[session.workout].exercises.map((exercise) => exercise.name));
    const following = followingWorkout(session.workout);
    manager.change({ ...manager.getSnapshot(), history: addWorkoutToHistory(history, session), completed: [session, ...completed.filter((item) => item.id !== session.id)], drafts: Object.fromEntries(Object.entries(drafts).filter(([name]) => !names.has(name))), checkpoints: Object.fromEntries(Object.entries(checkpoints).filter(([name]) => !names.has(name))), activeWorkout: null, next: following, bodyweight: "", sessionNote: "" });
    setActiveTab(following); setFinishing(false); setFinishEndedAt(null); setFinishError(""); window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const beginFinish = () => {
    if (!activeWorkout || finishing) return;
    const endedAt = new Date().toISOString();
    setFinishEndedAt(endedAt); setFinishing(true); setFinishError("");
  };
  const resumeWorkout = () => { setFinishing(false); setFinishEndedAt(null); setFinishError(""); };

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
    if (!autumn.token || !hasDestination) { setAutumnStatus("Choose an Autumn connection and gym project before syncing."); setAutumnOpen(true); return; }
    setAutumnBusy(true); updateCompleted(session.id, (current) => ({ ...current, sync: { ...current.sync, status: "syncing", message: "Sending to Autumn…" } }));
    const destination = session.sync.projectId && session.sync.projectName ? { ...autumn, projectId: session.sync.projectId, projectName: session.sync.projectName } : autumn;
    try { const result = await pushWorkoutToAutumn(destination, session); updateCompleted(session.id, (current) => ({ ...current, sync: { status: "synced", projectId: destination.projectId, projectName: destination.projectName, autumnSessionId: result.id, syncedAt: new Date().toISOString() } })); setAutumnStatus(`Synced ${session.workout} to ${destination.projectName}.`); }
    catch (error) { const message = error instanceof Error ? error.message : "Unknown error"; updateCompleted(session.id, (current) => ({ ...current, sync: { ...current.sync, status: "error", message: `Sync failed: ${message}` } })); setAutumnStatus(`Sync failed: ${message}`); }
    finally { setAutumnBusy(false); }
  };

  const importHistory = (text: string) => {
      const parsed = parseBackupText(text);
      const nextHistory: HistoryMap = { ...history };
      parsed.sessions.forEach((session) => {
        const byId = new Map((nextHistory[session.exercise] ?? []).map((saved) => [saved.id, saved]));
        const existing = byId.get(session.sessionId);
        const restored = { id: session.sessionId, savedAt: session.performedAt, sets: session.sets.map(({ id, load, reps }, index) => ({ ...(id || existing?.sets[index]?.id ? { id: id || existing?.sets[index]?.id } : {}), load, reps })) };
        byId.set(restored.id, restored); nextHistory[session.exercise] = Array.from(byId.values()).sort((left, right) => right.savedAt.localeCompare(left.savedAt));
      });
      const byId = new Map(completed.map((session) => [session.id, session]));
      parsed.workouts.forEach((session) => {
        const existing = byId.get(session.id);
        byId.set(session.id, { ...session, exercises: session.exercises.map((exercise) => {
          const previous = existing?.exercises.find((item) => item.name === exercise.name);
          return { ...exercise, sets: exercise.sets.map((set, index) => ({ ...set, ...(set.id || previous?.sets[index]?.id ? { id: set.id || previous?.sets[index]?.id } : {}) })) };
        }) });
      });
      manager.change({ ...manager.getSnapshot(), history: nextHistory, completed: Array.from(byId.values()).sort((left, right) => right.endedAt.localeCompare(left.endedAt)) });
      return `Imported ${parsed.sessions.length} lift record${parsed.sessions.length === 1 ? "" : "s"}${parsed.workouts.length ? ` and ${parsed.workouts.length} workouts` : ""}.`;
  };

  const latest = completed.find((session) => session.sync.status !== "legacy");
  const pending = completed.filter((session) => session.sync.status === "unsynced" || session.sync.status === "error" || session.sync.status === "syncing");
  const finishSummary = useMemo<FinishSummary>(() => {
    if (!activeWorkout) return { exerciseCount: 0, exerciseTotal: 0, setCount: 0, missingMust: [], unsaved: [] };
    const definitions = workouts[activeWorkout.workout].exercises;
    const entered = definitions.map((exercise) => ({ exercise, result: selectedExerciseSets(drafts[exercise.name] ?? []) })).filter(({ result }) => result.sets.length > 0);
    return {
      exerciseCount: entered.length,
      exerciseTotal: definitions.length,
      setCount: entered.reduce((sum, { result }) => sum + result.sets.length, 0),
      missingMust: definitions.filter((exercise) => exercise.priority === "must" && !entered.some((item) => item.exercise.name === exercise.name)).map((exercise) => exercise.name),
      unsaved: entered.filter(({ exercise }) => checkpoints[exercise.name]?.workoutId !== activeWorkout.id || checkpoints[exercise.name]?.fingerprint !== exerciseFingerprint(drafts[exercise.name] ?? [])).map(({ exercise }) => exercise.name),
    };
  }, [activeWorkout, checkpoints, drafts]);
  return <>
    <header className="app-header"><div className="app-brand"><h1>Rolling PPL</h1><p>Chest-prioritized · no weekly reset</p></div><nav className="primary-nav" aria-label="App sections"><button type="button" className={appView === "train" ? "active" : ""} aria-current={appView === "train" ? "page" : undefined} onClick={() => setAppView("train")}>Train{activeWorkout && <i aria-label="Workout in progress" />}</button><button type="button" className={appView === "progress" ? "active" : ""} aria-current={appView === "progress" ? "page" : undefined} onClick={() => setAppView("progress")}>Progress</button><button type="button" className={appView === "sessions" ? "active" : ""} aria-current={appView === "sessions" ? "page" : undefined} onClick={() => setAppView("sessions")}>Sessions</button></nav><div className="header-actions"><PeerSyncPanel manager={manager} /><button className="utility-button" type="button" onClick={() => setAutumnOpen(true)}>Autumn{pending.length > 0 && <b>{pending.length}</b>}</button><DataMenu history={history} workouts={completed} onImport={importHistory} />{installPrompt && <button className="install-button" type="button" onClick={installApp}>Install</button>}<button className="theme-toggle" type="button" onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}><span aria-hidden="true">{theme === "dark" ? "☀" : "☾"}</span></button></div></header>
    <main>
      {appView === "train" ? <><TrainingRail next={next} active={activeWorkout} finishEndedAt={finishEndedAt ?? undefined} finishing={finishing} latest={latest} syncBusy={autumnBusy} onSetNext={(workout) => { setNext(workout); setActiveTab(workout); }} onStart={startWorkout} onFinish={beginFinish} onCancel={cancelWorkout} onSync={syncWorkout} />
        {finishing && activeWorkout && <FinishWorkout workout={activeWorkout.workout} bodyweight={bodyweight} note={sessionNote} error={finishError} summary={finishSummary} onBodyweight={setBodyweight} onNote={setSessionNote} onBack={resumeWorkout} onSave={saveFinishedWorkout} />}
        <div className="workout-tabs" role="tablist" aria-label="Choose a workout to view">{WORKOUT_SEQUENCE.map((key) => <button key={key} role="tab" aria-selected={activeTab === key} className={activeTab === key ? `active ${key}` : ""} onClick={() => setActiveTab(key)}>{key}<small>{activeWorkout?.workout === key ? "logging now" : `${workouts[key].exercises.length} exercises`}</small></button>)}</div>
        <p className="storage-note">Entries recover automatically. Save each exercise when done; finish once.</p>
        <Workout workout={activeTab} onOpen={setLightbox} history={history} drafts={drafts} enabled={activeWorkout?.workout === activeTab && !finishing} activeWorkoutId={activeWorkout?.workout === activeTab ? activeWorkout.id : undefined} checkpoints={checkpoints} onDraftChange={updateDraft} onSave={saveExercise} /><Notes /></>
        : appView === "sessions" ? <SessionHistory sessions={completed} definitions={sessionDefinitions} onSave={saveSessionEdit} /> : <Progress sessions={completed} history={history} />}
    </main>
    <footer><p><strong>Rolling PPL</strong> · Keep the sequence; skip the weekly reset.</p><p>Exercise imagery from the public-domain <a href="https://github.com/yuhonas/free-exercise-db" target="_blank" rel="noreferrer">Free Exercise DB</a> (Unlicense).</p></footer>
    <Lightbox image={lightbox} onClose={() => setLightbox(null)} />
    <AutumnModal open={autumnOpen} onClose={() => setAutumnOpen(false)}><AutumnConnection settings={autumn} projects={autumnProjects} status={autumnStatus} busy={autumnBusy} pending={pending} onSettings={setAutumn} onSignIn={signIn} onTest={testConnection} onLoad={loadProjects} onSync={syncWorkout} /></AutumnModal>
  </>;
}

function initialSyncSnapshot(): SyncSnapshot {
  const history = canonicalizeHistory(readStored<HistoryMap>(HISTORY_KEY, {}), Infinity);
  const stored = readStored<CompletedWorkout[]>(WORKOUTS_KEY, []);
  const completed = stored.length ? stored : migrateLegacyHistory(history, exerciseWorkouts);
  const activeWorkout = readStored<ActiveWorkout | null>(ACTIVE_WORKOUT_KEY, null);
  const storedNext = readStored<unknown>(NEXT_WORKOUT_KEY, "");
  return { history, completed, activeWorkout,
    drafts: activeWorkout ? readStored<DraftMap>(DRAFTS_KEY, {}) : pruneCompletedDrafts(readStored<DraftMap>(DRAFTS_KEY, {}), history),
    checkpoints: readStored<CheckpointMap>(CHECKPOINTS_KEY, {}),
    next: isWorkoutKey(storedNext) ? storedNext : completed[0] ? followingWorkout(completed[0].workout) : "push",
    bodyweight: "", sessionNote: "" };
}

async function boot() {
  const manager = new PeerSyncManager(initialSyncSnapshot());
  await manager.initialize();
  createRoot(document.getElementById("root")!).render(<StrictMode><App manager={manager} /></StrictMode>);
  if ("serviceWorker" in navigator && import.meta.env.PROD) {
    void navigator.serviceWorker.register("./sw.js").then((registration) => {
      void registration.update();
      document.addEventListener("visibilitychange", () => { if (!document.hidden) void registration.update(); });
    }).catch(() => { /* Local logging also works without an installed worker. */ });
  }
}

// One writer per browser profile prevents two tabs from overwriting the same
// persistent Automerge actor/identity. Separate browsers and devices remain peers.
if (navigator.locks) {
  void navigator.locks.request("rolling-ppl-writer-v1", { ifAvailable: true }, async (lock) => {
    if (!lock) {
      document.getElementById("root")!.textContent = "Rolling PPL is already open in another tab in this browser. Use that tab, or close it and reload this page.";
      return;
    }
    await boot();
    await new Promise<void>(() => {});
  }).catch((error) => { document.getElementById("root")!.textContent = `Rolling PPL could not open its local data: ${String(error)}. Your saved data has not been cleared.`; });
} else {
  void boot().catch((error) => { document.getElementById("root")!.textContent = `Rolling PPL could not open its local data: ${String(error)}. Your saved data has not been cleared.`; });
}

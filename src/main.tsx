import { Fragment, StrictMode, useEffect, useMemo, useState, type ChangeEvent, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  DEFAULT_AUTUMN_URL, defaultAutumnSettings, getAutumnAccount, listAutumnProjects,
  pushWorkoutToAutumn, signInToAutumn, type AutumnProject, type AutumnSettings,
} from "./autumn";
import { createCsvBackup, createJsonBackup, parseCsvBackup, parseJsonBackup } from "./backup";
import { pruneCompletedDrafts, type DraftMap } from "./drafts";
import { canonicalizeHistory, type HistoryMap, type SavedSession, type SetEntry } from "./historyMigration";
import { nextStep, setTarget } from "./progression";
import { availableChartExercises, bodyweightSeries, exerciseMetricSeries, type ExerciseSeries } from "./progressModel";
import {
  WORKOUT_SEQUENCE, addWorkoutToHistory, completeWorkout, createActiveWorkout, elapsedLabel, liftMilestones,
  migrateLegacyHistory, nextWorkout as followingWorkout, sessionsInLastDays, workoutDurationMinutes,
  workoutSummary, type ActiveWorkout, type CompletedWorkout, type WorkoutKey,
} from "./sessionModel";
import "./styles.css";

type Theme = "light" | "dark";
type AppView = "train" | "progress";
type Demo = { label: string; slug: string };
type Exercise = {
  name: string; sets: string; reps: string; rest: string; warmup: string; cue: string;
  priority: "must" | "optional"; loadSuffix?: string; demos: Demo[];
};
type LightboxImage = { src: string; alt: string };
type ExportFormat = "json" | "csv";
type ImportResult = { kind: "success" | "error"; message: string } | null;
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

function downloadHistory(history: HistoryMap, completedWorkouts: CompletedWorkout[], format: ExportFormat) {
  const dateStamp = new Date().toISOString().slice(0, 10);
  const content = format === "json" ? createJsonBackup(history, completedWorkouts) : createCsvBackup(history, completedWorkouts);
  const mimeType = format === "json" ? "application/json;charset=utf-8" : "text/csv;charset=utf-8";
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url; link.download = `rolling-ppl-history-${dateStamp}.${format}`; document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
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

function compactNumber(value: number, unit: "kg" | "kg·reps") {
  if (unit === "kg·reps" && value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function LineChart({ series, unit, emptyTitle, emptyHint, label }: {
  series: ExerciseSeries[]; unit: "kg" | "kg·reps"; emptyTitle: string; emptyHint: string; label: string;
}) {
  const points = series.flatMap((item) => item.points);
  if (!points.length) return <div className="empty-chart"><strong>{emptyTitle}</strong><span>{emptyHint}</span></div>;
  const values = points.map((point) => point.value); const rawMin = Math.min(...values); const rawMax = Math.max(...values);
  const padding = Math.max(unit === "kg" ? 1 : 25, (rawMax - rawMin) * .12); const min = Math.max(0, rawMin - padding); const max = rawMax + padding; const spread = Math.max(1, max - min);
  const dates = points.map((point) => Date.parse(point.date)); const firstDate = Math.min(...dates); const lastDate = Math.max(...dates); const dateSpread = Math.max(1, lastDate - firstDate);
  const xFor = (date: string) => firstDate === lastDate ? 410 : 58 + ((Date.parse(date) - firstDate) / dateSpread) * 710;
  const yFor = (value: number) => 224 - ((value - min) / spread) * 184;
  const ticks = Array.from({ length: 4 }, (_, index) => min + ((max - min) * index) / 3).reverse();
  const dateLabels = firstDate === lastDate ? [firstDate] : [firstDate, firstDate + dateSpread / 2, lastDate];
  return <div className="line-chart"><svg viewBox="0 0 800 260" role="img" aria-label={label}>
    {ticks.map((tick, index) => <g className="chart-grid" key={index}><line x1="58" y1={yFor(tick)} x2="768" y2={yFor(tick)} /><text x="48" y={yFor(tick) + 4}>{compactNumber(tick, unit)}</text></g>)}
    {dateLabels.map((date, index) => <text className="chart-date" key={date} x={dateLabels.length === 1 ? 410 : index === 0 ? 58 : index === dateLabels.length - 1 ? 768 : 413} y="251" textAnchor={dateLabels.length === 1 ? "middle" : index === 0 ? "start" : index === dateLabels.length - 1 ? "end" : "middle"}>{new Date(date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</text>)}
    {series.map((item, seriesIndex) => { const coordinates = item.points.map((point) => ({ ...point, x: xFor(point.date), y: yFor(point.value) })); return <g className={`chart-series series-${seriesIndex % 6}`} key={item.exercise}><polyline points={coordinates.map(({ x, y }) => `${x},${y}`).join(" ")} />{coordinates.map((point, pointIndex) => <circle key={`${point.date}-${point.value}-${pointIndex}`} cx={point.x} cy={point.y} r="4"><title>{item.exercise} · {new Date(point.date).toLocaleDateString()} · {compactNumber(point.value, unit)} {unit}</title></circle>)}</g>; })}
  </svg><div className="chart-legend">{series.map((item, index) => <span className={`series-${index % 6}`} key={item.exercise}><i />{item.exercise}</span>)}</div></div>;
}

function ExercisePicker({ available, selected, onChange }: { available: string[]; selected: string[]; onChange: (selected: string[]) => void }) {
  const toggle = (exercise: string) => onChange(selected.includes(exercise) ? selected.filter((item) => item !== exercise) : [...selected, exercise]);
  const close = (event: MouseEvent<HTMLButtonElement>) => { const picker = event.currentTarget.closest("details"); if (picker instanceof HTMLDetailsElement) picker.open = false; };
  return <details className="exercise-picker"><summary>{selected.length ? `${selected.length} exercise${selected.length === 1 ? "" : "s"}` : "Choose exercises"}</summary><div><header><span>Lines to show · up to 6</span><div className="picker-actions"><button type="button" onClick={() => onChange([])}>Clear</button><button className="picker-done" type="button" onClick={close}>Done</button></div></header>{available.map((exercise) => { const checked = selected.includes(exercise); return <label key={exercise}><input type="checkbox" checked={checked} disabled={!checked && selected.length >= 6} onChange={() => toggle(exercise)} /><span>{exercise}</span></label>; })}</div></details>;
}

function BodyweightChart({ sessions }: { sessions: CompletedWorkout[] }) {
  const readings = bodyweightSeries(sessions); const latest = readings.at(-1); const first = readings[0];
  const delta = latest && first && readings.length > 1 ? latest.value - first.value : null;
  const series = readings.length ? [{ exercise: "Bodyweight", points: readings }] : [];
  return <article className="chart-card bodyweight-chart-card"><div className="chart-card-heading"><div><span className="eyebrow">Bodyweight</span><h3>{latest ? `${latest.value.toFixed(2)} kg` : "No readings"}</h3><p>{latest ? `${readings.length} reading${readings.length === 1 ? "" : "s"}${delta === null ? "" : ` · ${delta >= 0 ? "+" : ""}${delta.toFixed(2)} kg across this view`}` : "Add bodyweight when finishing a workout."}</p></div>{latest && <time dateTime={latest.date}>Latest · {new Date(latest.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time>}</div><LineChart series={series} unit="kg" emptyTitle="No bodyweight line yet." emptyHint="Your readings will appear here after a finished workout." label={`Bodyweight chart with ${readings.length} readings`} /></article>;
}

function ExerciseChart({ title, description, metric, history, storageKey }: { title: string; description: string; metric: "volume" | "load"; history: HistoryMap; storageKey: string }) {
  const available = availableChartExercises(history);
  const [selected, setSelected] = useState<string[]>(() => {
    const hasStoredChoice = localStorage.getItem(storageKey) !== null; const stored = readStored<string[]>(storageKey, []); const valid = stored.filter((exercise) => available.includes(exercise)).slice(0, 6);
    if (hasStoredChoice) return valid;
    const bench = available.find((exercise) => exercise === "Barbell bench press"); return (bench ? [bench] : available.slice(0, 1));
  });
  const visible = selected.filter((exercise) => available.includes(exercise));
  useEffect(() => storeLocal(storageKey, selected), [selected, storageKey]);
  const series = exerciseMetricSeries(history, visible, metric);
  const unit = metric === "volume" ? "kg·reps" : "kg";
  return <article className="chart-card exercise-chart-card"><div className="chart-card-heading"><div><span className="eyebrow">{metric === "volume" ? "Work performed" : "Top set"}</span><h3>{title}</h3><p>{description}</p></div><ExercisePicker available={available} selected={visible} onChange={setSelected} /></div><LineChart series={series} unit={unit} emptyTitle={visible.length ? "No numeric loads for this selection." : "Choose an exercise to draw the line."} emptyHint={visible.length ? "Loads recorded as BW or text cannot be plotted in kilograms." : "Use the exercise picker above."} label={`${title} chart for ${visible.join(", ") || "no selected exercises"}`} />{metric === "volume" && <p className="chart-footnote">Recorded-load volume uses load × reps. Dumbbell values remain per dumbbell; BW and text loads are excluded.</p>}</article>;
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
  return <section className="progress" aria-labelledby="progress-title"><div className="section-heading progress-heading"><div><span className="eyebrow">Training record</span><h2 id="progress-title">Progress</h2></div><p>Facts from completed workouts—no streaks and no makeup debt.</p></div><BodyweightChart sessions={sessions} /><div className="metric-chart-grid"><ExerciseChart title="Volume" description="Total recorded load × reps for each workout." metric="volume" history={history} storageKey={VOLUME_EXERCISES_KEY} /><ExerciseChart title="Working weight" description="The heaviest completed set in each workout." metric="load" history={history} storageKey={LOAD_EXERCISES_KEY} /></div><div className="progress-support"><article className="frequency-card"><span>Last 28 days</span><strong>{recent.length}</strong><p>completed workout{recent.length === 1 ? "" : "s"}{average ? ` · ${average} min average` : ""}</p><div>{WORKOUT_SEQUENCE.map((workout) => <span className={workout} key={workout}>{workout} <b>{recent.filter((session) => session.workout === workout).length}</b></span>)}</div></article>{milestones.length > 0 && <div className="milestones"><h3>Recent milestones</h3><div>{milestones.map((milestone) => <article key={`${milestone.exercise}-${milestone.date}-${milestone.kind}`}><span>{milestone.kind === "load" ? "New load" : "Rep record"}</span><strong>{milestone.exercise}</strong><p>{milestone.load || "BW"} × {milestone.reps}</p><time>{new Date(milestone.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time></article>)}</div></div>}</div><div className="lift-progress"><h3>Recent lifts</h3>{liftHistory.length ? <div className="lift-grid">{liftHistory.map(([name, saved]) => { const record = bestRecordedSet([...saved]); return <details key={name}><summary><span>{name}</span><strong>{record ? `${record.load || "BW"} × ${record.reps}` : "—"}<small>recorded best</small></strong></summary><ol>{saved.slice(0, 4).map((session) => <li key={session.id}><time>{new Date(session.savedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time><span>{formatSession(session)}</span></li>)}</ol></details>; })}</div> : <div className="empty-progress"><strong>No completed lifts yet.</strong><span>Finish a workout to begin the record.</span></div>}</div></section>;
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

function App() {
  const initialHistory = useMemo(() => canonicalizeHistory(readStored<HistoryMap>(HISTORY_KEY, {})), []);
  const [history, setHistory] = useState<HistoryMap>(initialHistory);
  const [drafts, setDrafts] = useState<DraftMap>(() => pruneCompletedDrafts(readStored<DraftMap>(DRAFTS_KEY, {}), initialHistory));
  const [completed, setCompleted] = useState<CompletedWorkout[]>(() => { const stored = readStored<CompletedWorkout[]>(WORKOUTS_KEY, []); return stored.length ? stored : migrateLegacyHistory(initialHistory, exerciseWorkouts); });
  const [activeWorkout, setActiveWorkout] = useState<ActiveWorkout | null>(() => readStored<ActiveWorkout | null>(ACTIVE_WORKOUT_KEY, null));
  const [next, setNext] = useState<WorkoutKey>(() => { const stored = readStored<unknown>(NEXT_WORKOUT_KEY, ""); if (isWorkoutKey(stored)) return stored; const sessions = readStored<CompletedWorkout[]>(WORKOUTS_KEY, []); if (sessions[0] && isWorkoutKey(sessions[0].workout)) return followingWorkout(sessions[0].workout); const legacy = migrateLegacyHistory(initialHistory, exerciseWorkouts); return legacy[0] ? followingWorkout(legacy[0].workout) : "push"; });
  const [activeTab, setActiveTab] = useState<WorkoutKey>(() => activeWorkout?.workout ?? next);
  const [appView, setAppView] = useState<AppView>(() => readStored<AppView>(APP_VIEW_KEY, "train") === "progress" ? "progress" : "train");
  const [lightbox, setLightbox] = useState<LightboxImage | null>(null);
  const [autumnOpen, setAutumnOpen] = useState(false);
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
  useEffect(() => storeLocal(APP_VIEW_KEY, appView), [appView]);
  useEffect(() => storeLocal(AUTUMN_KEY, autumn), [autumn]);
  useEffect(() => { document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#171d24" : "#f2f4f6"); storeLocal(THEME_KEY, theme); }, [theme]);
  useEffect(() => { if (!activeWorkout) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, [activeWorkout]);
  useEffect(() => { const onPrompt = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPromptEvent); }; const onInstalled = () => setInstallPrompt(null); window.addEventListener("beforeinstallprompt", onPrompt); window.addEventListener("appinstalled", onInstalled); return () => { window.removeEventListener("beforeinstallprompt", onPrompt); window.removeEventListener("appinstalled", onInstalled); }; }, []);

  const installApp = async () => { if (!installPrompt) return; await installPrompt.prompt(); await installPrompt.userChoice; setInstallPrompt(null); };
  const updateDraft = (name: string, entries: SetEntry[]) => setDrafts((current) => ({ ...current, [name]: entries }));
  const startWorkout = () => { const active = createActiveWorkout(next); setActiveWorkout(active); setActiveTab(next); setAppView("train"); setNow(Date.now()); setFinishing(false); setFinishError(""); window.scrollTo({ top: 0, behavior: "smooth" }); };
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
    if (!autumn.token || !hasDestination) { setAutumnStatus("Choose an Autumn connection and gym project before syncing."); setAutumnOpen(true); return; }
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
      const text = await file.text(); const parsed = file.name.toLowerCase().endsWith(".csv") ? parseCsvBackup(text) : parseJsonBackup(text);
      setHistory((current) => { const nextHistory: HistoryMap = { ...current }; parsed.sessions.forEach((session) => { const restored = { id: session.sessionId, savedAt: session.performedAt, sets: session.sets.map(({ load, reps }) => ({ load, reps })) }; const byId = new Map((nextHistory[session.exercise] ?? []).map((saved) => [saved.id, saved])); byId.set(restored.id, restored); nextHistory[session.exercise] = Array.from(byId.values()).sort((left, right) => right.savedAt.localeCompare(left.savedAt)); }); return nextHistory; });
      if (parsed.workouts.length) setCompleted((current) => { const byId = new Map(current.map((session) => [session.id, session])); parsed.workouts.forEach((session) => byId.set(session.id, session)); return Array.from(byId.values()).sort((left, right) => right.endedAt.localeCompare(left.endedAt)); });
      setImportResult({ kind: "success", message: `Imported ${parsed.sessions.length} lift record${parsed.sessions.length === 1 ? "" : "s"}${parsed.workouts.length ? ` and ${parsed.workouts.length} workouts` : ""}.` });
    } catch (error) { setImportResult({ kind: "error", message: error instanceof Error ? error.message : "The file could not be read." }); }
    finally { input.value = ""; }
  };

  const latest = completed.find((session) => session.sync.status !== "legacy");
  const pending = completed.filter((session) => session.sync.status === "unsynced" || session.sync.status === "error" || session.sync.status === "syncing");
  return <>
    <header className="app-header"><div className="app-brand"><h1>Rolling PPL</h1><p>Chest-prioritized · no weekly reset</p></div><nav className="primary-nav" aria-label="App sections"><button type="button" className={appView === "train" ? "active" : ""} aria-current={appView === "train" ? "page" : undefined} onClick={() => setAppView("train")}>Train{activeWorkout && <i aria-label="Workout in progress" />}</button><button type="button" className={appView === "progress" ? "active" : ""} aria-current={appView === "progress" ? "page" : undefined} onClick={() => setAppView("progress")}>Progress</button></nav><div className="header-actions"><button className="utility-button" type="button" onClick={() => setAutumnOpen(true)}>Autumn{pending.length > 0 && <b>{pending.length}</b>}</button><details className="export-menu"><summary aria-label="Export or import workout history">Data</summary><div className="export-panel"><span>Workout history</span><button type="button" disabled={!hasHistory} onClick={() => downloadHistory(history, completed, "json")}>JSON <small>Full backup</small></button><button type="button" disabled={!hasHistory} onClick={() => downloadHistory(history, completed, "csv")}>CSV <small>Spreadsheet</small></button><div className="export-separator" /><label className="import-button">Import <small>JSON or CSV</small><input className="file-input" type="file" accept=".json,.csv,application/json,text/csv" onChange={importHistory} /></label>{importResult && <p className={`import-result ${importResult.kind}`} role="status">{importResult.message}</p>}</div></details>{installPrompt && <button className="install-button" type="button" onClick={installApp}>Install</button>}<button className="theme-toggle" type="button" onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}><span aria-hidden="true">{theme === "dark" ? "☀" : "☾"}</span></button></div></header>
    <main>
      {appView === "train" ? <><TrainingRail next={next} active={activeWorkout} now={now} finishing={finishing} latest={latest} syncBusy={autumnBusy} onSetNext={(workout) => { setNext(workout); setActiveTab(workout); }} onStart={startWorkout} onFinish={() => setFinishing(true)} onCancel={cancelWorkout} onSync={syncWorkout} />
        {finishing && activeWorkout && <FinishWorkout workout={activeWorkout.workout} bodyweight={bodyweight} note={sessionNote} error={finishError} onBodyweight={setBodyweight} onNote={setSessionNote} onBack={() => { setFinishing(false); setFinishError(""); }} onSave={saveFinishedWorkout} />}
        <div className="workout-tabs" role="tablist" aria-label="Choose a workout to view">{WORKOUT_SEQUENCE.map((key) => <button key={key} role="tab" aria-selected={activeTab === key} className={activeTab === key ? `active ${key}` : ""} onClick={() => setActiveTab(key)}>{key}<small>{activeWorkout?.workout === key ? "logging now" : `${workouts[key].exercises.length} exercises`}</small></button>)}</div>
        <p className="storage-note">Sets autosave on this device. Finish once; sync to Autumn when ready.</p>
        <Workout workout={activeTab} onOpen={setLightbox} history={history} drafts={drafts} enabled={activeWorkout?.workout === activeTab && !finishing} onDraftChange={updateDraft} /><Notes /></>
        : <Progress sessions={completed} history={history} />}
    </main>
    <footer><p><strong>Rolling PPL</strong> · Keep the sequence; skip the weekly reset.</p><p>Exercise imagery from the public-domain <a href="https://github.com/yuhonas/free-exercise-db" target="_blank" rel="noreferrer">Free Exercise DB</a> (Unlicense).</p></footer>
    <Lightbox image={lightbox} onClose={() => setLightbox(null)} />
    <AutumnModal open={autumnOpen} onClose={() => setAutumnOpen(false)}><AutumnConnection settings={autumn} projects={autumnProjects} status={autumnStatus} busy={autumnBusy} pending={pending} onSettings={setAutumn} onSignIn={signIn} onTest={testConnection} onLoad={loadProjects} onSync={syncWorkout} /></AutumnModal>
  </>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

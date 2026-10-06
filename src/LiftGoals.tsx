import { useEffect, useRef, useState, type FormEvent } from "react";
import type { HistoryMap } from "./historyMigration";
import type { TrainingPhase } from "./planModel";
import { availableChartExercises } from "./progressModel";
import {
  MAX_ACTIVE_LIFT_GOALS, deleteLiftGoal, estimatedMax, isGoalReached, liftGoalProgress, loadForReps, liftSets, reachedOn, saveLiftGoal, suggestSteps,
  type LiftGoal, type LiftGoalProgress, type LiftGoalsData,
} from "./liftGoalModel";
import "./liftGoals.css";

type Draft = { id?: string; exercise: string; load: string; reps: string; steps: number[] | null };
const kg = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 });
const approx = (value: number) => kg(Math.round(value * 2) / 2);
const day = (value: string) => new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const parse = (value: string) => Number(value.trim().replace(",", "."));
const RECENT_REACHED_DAYS = 30;
// Set by the workout summary so "Set your next goal" lands on an open section.
export const OPEN_LIFT_GOALS_KEY = "rolling-ppl-open-lift-goals";

function month(value: string) {
  const date = new Date(value);
  return date.toLocaleDateString(undefined, { month: "short", ...(date.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
}
function eta(progress: LiftGoalProgress) {
  if (!progress.eta) return null;
  const from = month(progress.eta.from), to = month(progress.eta.to);
  return from === to ? from : `${from} – ${to}`;
}
// The plan's rep range for a lift, if it is in the current phase.
function planRange(phase: TrainingPhase | undefined, exercise: string) {
  const match = Object.values(phase?.workouts ?? {}).flatMap((workout) => workout.exercises).find((item) => item.name === exercise || item.alternatives?.includes(exercise));
  const values = match?.reps.match(/\d+/g)?.map(Number) ?? [];
  return values.length >= 2 ? { min: values[0], max: values[1], text: match!.reps } : null;
}
function Ring({ fraction, reached }: { fraction: number; reached?: boolean }) {
  return reached
    ? <svg className="lift-goal-ring reached" width="40" height="40" viewBox="0 0 42 42" aria-hidden="true"><circle cx="21" cy="21" r="17" /><path d="M14 21.5l4.5 4.5 9-10" /></svg>
    : <svg className="lift-goal-ring" width="40" height="40" viewBox="0 0 42 42" aria-hidden="true"><circle cx="21" cy="21" r="17" /><circle className="fill" cx="21" cy="21" r="17" strokeDasharray={`${(fraction * 106.8).toFixed(1)} 107`} transform="rotate(-90 21 21)" /></svg>;
}

function FeaturedGoal({ goal, progress, onEdit }: { goal: LiftGoal; progress: LiftGoalProgress; onEdit: () => void }) {
  const { start, now, fraction, marks, next } = progress;
  const goalMax = estimatedMax(goal.load, goal.reps);
  const tick = (load: number) => start && goalMax > start.max ? (estimatedMax(load, goal.reps) - start.max) / (goalMax - start.max) : null;
  const timing = eta(progress);
  return <article className="lift-goal-card">
    <div className="lift-goal-head"><div><span className="lift-goal-eyebrow">{goal.exercise}</span><h4>{kg(goal.load)} kg × {goal.reps} <small>goal</small></h4></div><button type="button" className="lift-goal-link" onClick={onEdit}>Edit</button></div>
    {now && fraction !== null ? <>
      <div className="lift-goal-bar" role="progressbar" aria-label={`${goal.exercise} goal progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
        <i style={{ width: `${fraction * 100}%` }} />
        {marks.filter((mark) => !mark.final).map((mark) => { const at = tick(mark.load); return at !== null && at > 0 && at < 1 ? <em key={mark.load} style={{ left: `${at * 100}%` }} /> : null; })}
      </div>
      <div className="lift-goal-legend"><span>{start ? `Started ~${approx(loadForReps(start.max, goal.reps))} × ${goal.reps} · ${day(goal.createdAt)}` : `Set ${day(goal.createdAt)}`}</span><span><b>{Math.round(fraction * 100)}%</b> of the way</span></div>
      <div className="lift-goal-now">
        <div><span className="lift-goal-eyebrow">You, now</span><strong>~{approx(progress.nowAtGoalReps!)} kg × {goal.reps}</strong><small>from {kg(now.load)} × {now.reps} on {day(now.date)}</small></div>
        <div className="goal"><span className="lift-goal-eyebrow">Goal</span><strong>{kg(goal.load)} kg × {goal.reps}</strong><small>{progress.repsAtGoalLoad! < 1 ? `under 1 rep at ${kg(goal.load)} kg today` : `~${Math.floor(progress.repsAtGoalLoad!)} rep${Math.floor(progress.repsAtGoalLoad!) === 1 ? "" : "s"} at ${kg(goal.load)} kg today`}</small></div>
      </div>
    </> : <p className="lift-goal-empty-note">Log a set of {goal.exercise} with a weight to start tracking this goal.</p>}
    <span className="lift-goal-eyebrow">{marks.length > 1 ? `Your steps at ${goal.reps} reps` : `Goal at ${goal.reps} reps`}</span>
    <ol className="lift-goal-ladder">{marks.map((mark) => <li key={mark.load} className={mark.reachedOn ? "hit" : mark === next ? "next" : mark.final ? "goal" : undefined}><b>{kg(mark.load)}{mark.final ? " kg" : ""}</b>{mark.reachedOn ? day(mark.reachedOn) : mark === next ? "next" : mark.final ? "goal" : " "}</li>)}</ol>
    {timing && <p className="lift-goal-eta">At your pace over the last 8 weeks: <strong>around {timing}</strong>. A rough guide; progress slows as you get stronger.</p>}
  </article>;
}

function GoalEditor({ draft, data, history, phase, exercises, onDraft, onSave, onDelete, onCancel, error }: {
  draft: Draft; data: LiftGoalsData | undefined; history: HistoryMap; phase?: TrainingPhase; exercises: string[];
  onDraft: (draft: Draft) => void; onSave: (steps: number[]) => void; onDelete?: () => void; onCancel: () => void; error: string;
}) {
  const load = parse(draft.load), reps = parse(draft.reps);
  const valid = draft.exercise && load > 0 && Number.isInteger(reps) && reps >= 1 && reps <= 30;
  const sets = liftSets(history, draft.exercise);
  const existing = data?.goals.find((goal) => goal.id === draft.id);
  const progress = valid ? liftGoalProgress({ id: "draft", exercise: draft.exercise, load, reps, steps: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, history) : null;
  const done = valid ? reachedOn(sets, load, reps) : null;
  const suggestion = valid ? suggestSteps(progress?.nowAtGoalReps ?? null, load, sets, reps) : { options: [], picked: [] };
  const options = [...new Set([...suggestion.options, ...(existing?.steps ?? []).filter((step) => step < load)])].sort((a, b) => a - b);
  const steps = (draft.steps ?? suggestion.picked).filter((step) => options.includes(step));
  const stronger = progress?.now ? estimatedMax(load, reps) / progress.now.max - 1 : null;
  const range = planRange(phase, draft.exercise);
  const submit = (event: FormEvent) => { event.preventDefault(); if (valid && (!done || existing)) onSave(steps); };
  return <form className="lift-goal-card lift-goal-editor" onSubmit={submit}>
    <h4>{existing ? "Edit lift goal" : "New lift goal"}</h4>
    <label>Lift<select value={draft.exercise} onChange={(event) => onDraft({ ...draft, exercise: event.target.value, steps: null })} disabled={Boolean(existing)}>{!draft.exercise && <option value="">Choose a lift</option>}{exercises.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
    <div className="lift-goal-pair">
      <label>Weight (kg)<input inputMode="decimal" required value={draft.load} placeholder="e.g. 100" onChange={(event) => onDraft({ ...draft, load: event.target.value, steps: null })} /></label>
      <label>Reps<input inputMode="numeric" required value={draft.reps} placeholder="e.g. 5" onChange={(event) => onDraft({ ...draft, reps: event.target.value, steps: null })} /></label>
    </div>
    {valid && <div className="lift-goal-insight">
      {done && !existing ? <p>You already logged {kg(load)} kg × {reps} or better on {day(done)}. Choose a higher target.</p>
        : progress?.now ? <p>Your best lately is <strong>{kg(progress.now.load)} kg × {progress.now.reps}</strong> ({day(progress.now.date)}), about <strong>~{approx(progress.nowAtGoalReps!)} kg × {reps}</strong>.{stronger !== null && stronger > 0 ? <> This goal is roughly <strong>{Math.round(stronger * 100)}% stronger</strong>{stronger > 0.4 ? ", a long-term target" : ""}.</> : " Your recent sets suggest it's already within reach."}</p>
        : <p>No weighted sets of this lift yet. Progress starts with your first logged set.</p>}
      {range && <p>{reps >= range.min && reps <= range.max ? `${reps} reps is inside your plan's ${range.text} range, so a normal session can reach it.` : `Your plan trains this lift at ${range.text} reps, so progress is estimated from those sets. Reaching the goal needs a set of ${reps} reps.`}</p>}
    </div>}
    {options.length > 0 && <fieldset className="lift-goal-steps"><legend>Steps along the way</legend><p>Each one you reach is starred on the chart.</p><div>{options.map((step) => { const on = steps.includes(step), hit = Boolean(reachedOn(sets, step, reps)); return <button type="button" key={step} aria-pressed={on} onClick={() => onDraft({ ...draft, steps: on ? steps.filter((item) => item !== step) : [...steps, step] })}>{kg(step)} × {reps}{hit ? " (reached)" : ""}{on ? " ✓" : ""}</button>; })}</div></fieldset>}
    {error && <p className="lift-goal-error" role="alert">{error}</p>}
    <div className="lift-goal-actions"><button type="submit" className="lift-goal-primary" disabled={!valid || (Boolean(done) && !existing)}>Save goal</button><button type="button" onClick={onCancel}>Cancel</button>{onDelete && <button type="button" className="lift-goal-delete" onClick={onDelete}>Delete goal</button>}</div>
  </form>;
}

export function LiftGoals({ data, history, phase, selected, onChange, onSelectLift }: {
  data: LiftGoalsData | undefined; history: HistoryMap; phase?: TrainingPhase; selected: string; onChange: (data: LiftGoalsData) => void; onSelectLift: (exercise: string) => void;
}) {
  const [featuredId, setFeaturedId] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [now] = useState(Date.now);
  const [requested] = useState(() => sessionStorage.getItem(OPEN_LIFT_GOALS_KEY) === "1");
  const [expanded, setExpanded] = useState(requested);
  const section = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    sessionStorage.removeItem(OPEN_LIFT_GOALS_KEY);
    if (requested) section.current?.scrollIntoView({ block: "start" });
  }, [requested]);
  const goals = (data?.goals ?? []).filter((goal) => !goal.deleted);
  const withProgress = goals.map((goal) => ({ goal, progress: liftGoalProgress(goal, history) }));
  const active = withProgress.filter(({ progress }) => !progress.reached).sort((a, b) => b.goal.updatedAt.localeCompare(a.goal.updatedAt));
  const reached = withProgress.filter(({ progress }) => progress.reached).sort((a, b) => b.progress.reached!.localeCompare(a.progress.reached!));
  const recent = reached.filter(({ progress }) => now - Date.parse(progress.reached!) < RECENT_REACHED_DAYS * 86_400_000);
  const featured = active.find(({ goal }) => goal.id === featuredId) ?? active[0];
  const taken = new Set(active.map(({ goal }) => goal.exercise));
  const planned = Object.values(phase?.workouts ?? {}).flatMap((workout) => workout.exercises.map((exercise) => exercise.name)).filter(Boolean);
  const exercises = [...new Set([...availableChartExercises(history), ...planned])].filter((name) => !taken.has(name) || name === draft?.exercise).sort((a, b) => a.localeCompare(b));
  const full = active.length >= MAX_ACTIVE_LIFT_GOALS;
  // New goals start on the charted lift, else the first lift with logged weights.
  const startingLift = [selected, ...availableChartExercises(history), ...exercises].find((name) => exercises.includes(name)) ?? "";
  function open(next: Draft) { setError(""); setDraft(next); }
  function save(steps: number[]) {
    if (!draft) return;
    try {
      const next = saveLiftGoal(data, { id: draft.id, exercise: draft.exercise, load: parse(draft.load), reps: parse(draft.reps), steps });
      onChange(next);
      const saved = next.goals.find((goal) => goal.exercise === draft.exercise && !goal.deleted && !isGoalReached(goal, history));
      if (saved) { setFeaturedId(saved.id); onSelectLift(saved.exercise); }
      setDraft(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The goal could not be saved."); }
  }
  function nextGoal(goal: LiftGoal) {
    const step = goal.load < 40 ? 2.5 : 5;
    open({ exercise: goal.exercise, load: String(goal.load + step), reps: String(goal.reps), steps: null });
  }
  const glance = featured ? `${featured.goal.exercise} · ${kg(featured.goal.load)} × ${featured.goal.reps} · ${Math.round((featured.progress.fraction ?? 0) * 100)}%${active.length > 1 ? ` · +${active.length - 1} more` : ""}` : recent.length ? `${recent[0].goal.exercise} goal reached` : "Set a target like bench 100 kg × 5";
  return <details className="lift-goals lift-collapsible" ref={section} open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary><span><h3>Lift goals</h3><small>{glance}</small></span></summary>
    <div className="lift-collapsible-body">
    {goals.length > 0 && <div className="lift-goals-heading">{!draft && <button type="button" className="lift-goal-link" disabled={full} title={full ? `Up to ${MAX_ACTIVE_LIFT_GOALS} goals at a time` : undefined} onClick={() => open({ exercise: startingLift, load: "", reps: "5", steps: null })}>{full ? `${MAX_ACTIVE_LIFT_GOALS} goals max` : "+ Add goal"}</button>}</div>}
    {draft && <GoalEditor draft={draft} data={data} history={history} phase={phase} exercises={exercises} onDraft={setDraft} onSave={save} onCancel={() => setDraft(null)} error={error}
      onDelete={draft.id ? () => { onChange(deleteLiftGoal(data!, draft.id!)); setDraft(null); } : undefined} />}
    {!draft && !goals.length && <div className="lift-goal-card lift-goal-intro"><p>Set a target like <strong>bench 100 kg × 5</strong>. Steps you reach along the way are starred on the lift chart.</p><button type="button" className="lift-goal-primary" onClick={() => open({ exercise: startingLift, load: "", reps: "5", steps: null })}>Set a lift goal</button></div>}
    {!draft && featured && <FeaturedGoal goal={featured.goal} progress={featured.progress} onEdit={() => open({ id: featured.goal.id, exercise: featured.goal.exercise, load: String(featured.goal.load), reps: String(featured.goal.reps), steps: featured.goal.steps })} />}
    {active.filter((item) => item !== featured).map(({ goal, progress }) => <button type="button" className="lift-goal-row" key={goal.id} onClick={() => { setFeaturedId(goal.id); onSelectLift(goal.exercise); }}>
      <Ring fraction={progress.fraction ?? 0} /><span><strong>{goal.exercise} · {kg(goal.load)} kg × {goal.reps}</strong><small>{progress.nowAtGoalReps !== null ? `~${approx(progress.nowAtGoalReps)} kg × ${goal.reps} now · ${Math.round((progress.fraction ?? 0) * 100)}% of the way` : "No sets logged yet"}</small></span><b aria-hidden="true">›</b>
    </button>)}
    {recent.map(({ goal, progress }) => <button type="button" className="lift-goal-row reached" key={goal.id} disabled={full || taken.has(goal.exercise)} onClick={() => nextGoal(goal)}>
      <Ring fraction={1} reached /><span><strong>{goal.exercise} · {kg(goal.load)} kg × {goal.reps}</strong><small>Reached {day(progress.reached!)}{!full && !taken.has(goal.exercise) ? " · set your next goal?" : ""}</small></span><b aria-hidden="true">›</b>
    </button>)}
    {reached.length > 0 && <details className="lift-goal-history"><summary>Reached goals ({reached.length})</summary><ul>{reached.map(({ goal, progress }) => <li key={goal.id}><span><strong>{goal.exercise} · {kg(goal.load)} kg × {goal.reps}</strong><small>Set {day(goal.createdAt)} · reached {day(progress.reached!)}</small></span><button type="button" onClick={() => onChange(deleteLiftGoal(data!, goal.id))}>Remove</button></li>)}</ul></details>}
    </div>
  </details>;
}

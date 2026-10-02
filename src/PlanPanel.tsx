import { useState, type FormEvent } from "react";
import { currentPhase, newPhase, validatePlanExercises, type PlanExercise, type PlanState, type PlanWorkouts, type TrainingPhase } from "./planModel";
import { defaultWorkouts } from "./defaultPlan";
import { WORKOUT_SEQUENCE, type CompletedWorkout, type WorkoutKey } from "./sessionModel";
import "./plans.css";

const catalog = Array.from(new Map(Object.values(defaultWorkouts).flatMap((workout) => workout.exercises.flatMap((exercise) => exercise.alternatives ? exercise.alternatives.map((name) => ({ ...exercise, name, alternatives: undefined })) : [exercise])).map((exercise) => [exercise.name, exercise])).values());
const newExercise = (): PlanExercise => ({ name: "", sets: "3", reps: "8–12", rest: "90 sec", warmup: "", cue: "", priority: "must", demos: [] });
const exerciseNames = (exercise: PlanExercise) => exercise.alternatives ?? [exercise.name];

export function PlanExerciseEditor({ exercises, onChange }: { exercises: PlanExercise[]; onChange: (exercises: PlanExercise[]) => void }) {
  const update = (index: number, change: Partial<PlanExercise>) => onChange(exercises.map((exercise, i) => i === index ? { ...exercise, ...change } : exercise));
  const move = (index: number, direction: number) => {
    const next = [...exercises]; [next[index], next[index + direction]] = [next[index + direction], next[index]]; onChange(next);
  };
  return <div className="plan-exercises">
    <datalist id="plan-exercise-catalog">{catalog.map((exercise) => <option key={exercise.name} value={exercise.name} />)}</datalist>
    {exercises.map((exercise, index) => <fieldset className="plan-exercise" key={index}>
      <legend>Exercise {index + 1}</legend>
      <div className="plan-exercise-heading"><label>Exercise name<input required maxLength={120} list="plan-exercise-catalog" value={exercise.name} onChange={(event) => {
        const name = event.target.value; const known = catalog.find((item) => item.name === name);
        update(index, { name, alternatives: undefined, demos: known?.demos ?? [], loadSuffix: known?.loadSuffix });
      }} /></label><div className="plan-reorder"><button type="button" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`Move exercise ${index + 1} up`}>↑</button><button type="button" disabled={index === exercises.length - 1} onClick={() => move(index, 1)} aria-label={`Move exercise ${index + 1} down`}>↓</button><button type="button" disabled={exercises.length === 1} onClick={() => onChange(exercises.filter((_, i) => i !== index))} aria-label={`Remove exercise ${index + 1}`}>Remove</button></div></div>
      {exercise.alternatives && <p className="plan-alternatives">Session choices: {exercise.alternatives.join(" / ")}. Editing the name replaces this slot with one exercise.</p>}
      <div className="plan-prescription"><label>Sets<input required maxLength={8} value={exercise.sets} onChange={(event) => update(index, { sets: event.target.value })} placeholder="3 or 3–4" /></label><label>Rep range<input required maxLength={8} value={exercise.reps} onChange={(event) => update(index, { reps: event.target.value })} placeholder="8–12" /></label><label>Rest<input maxLength={120} value={exercise.rest} onChange={(event) => update(index, { rest: event.target.value })} placeholder="2 min" /></label><label>Priority<select value={exercise.priority} onChange={(event) => update(index, { priority: event.target.value as PlanExercise["priority"] })}><option value="must">Must do</option><option value="optional">If time</option></select></label></div>
      <details><summary>Warm-up and cues</summary><label>Warm-up<input maxLength={240} value={exercise.warmup} onChange={(event) => update(index, { warmup: event.target.value })} /></label><label>Cue<textarea maxLength={2000} rows={2} value={exercise.cue} onChange={(event) => update(index, { cue: event.target.value })} /></label><label>Load convention<select value={exercise.loadSuffix ?? ""} onChange={(event) => update(index, { loadSuffix: event.target.value || undefined })}><option value="">Total weight / machine stack</option><option value=" each">Per dumbbell</option></select></label></details>
    </fieldset>)}
    <button className="secondary-action" type="button" disabled={exercises.length >= 30} onClick={() => onChange([...exercises, newExercise()])}>Add exercise</button>
  </div>;
}

export function SessionPlanEditor({ exercises, draftsWithSets, onSave, onClose }: {
  exercises: PlanExercise[]; draftsWithSets: string[]; onSave: (exercises: PlanExercise[]) => string; onClose: () => void;
}) {
  const [draft, setDraft] = useState(() => structuredClone(exercises));
  const [error, setError] = useState("");
  return <form className="session-plan-editor plan-form" onSubmit={(event) => {
    event.preventDefault();
    try {
      validatePlanExercises(draft);
      const names = new Set(draft.flatMap(exerciseNames));
      if (draftsWithSets.some((name) => !names.has(name))) throw new Error("Keep exercises with entered sets in this workout. Their names cannot be changed until those sets are cleared.");
      setError(onSave(draft));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to adjust this workout."); }
  }}><div className="section-heading"><div><span className="eyebrow">This session only</span><h2>Adjust this workout</h2></div><p>Your saved training phase stays the same.</p></div><PlanExerciseEditor exercises={draft} onChange={setDraft} />{error && <p className="form-error" role="alert">{error}</p>}<div className="finish-actions"><button className="primary-action" type="submit">Use for this workout</button><button className="secondary-action" type="button" onClick={onClose}>Cancel</button></div></form>;
}

function PhaseEditor({ state, template, onSave, onCancel }: { state: PlanState; template: TrainingPhase; onSave: (state: PlanState) => string; onCancel: () => void }) {
  const [name, setName] = useState(template.name);
  const [purpose, setPurpose] = useState(template.purpose);
  const [workouts, setWorkouts] = useState<PlanWorkouts>(() => structuredClone(template.workouts));
  const [tab, setTab] = useState<WorkoutKey>("push");
  const [error, setError] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      const summarized = Object.fromEntries(WORKOUT_SEQUENCE.map((key) => [key, { ...workouts[key], summary: `${workouts[key].exercises.length} exercises · ${name.trim()}` }])) as PlanWorkouts;
      setError(onSave(newPhase(state, name, purpose, summarized)));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to save the phase."); }
  };
  return <form className="plan-form" onSubmit={submit}><h3>New training phase</h3><p>Start with this plan, make your changes, then save a new phase. Earlier phases and completed sessions keep their original prescriptions.</p>
    <div className="phase-fields"><label>Phase name<input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="Chest emphasis" /></label><label>Purpose<textarea rows={2} maxLength={2000} value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder="What are you focusing on?" /></label></div>
    <div className="workout-tabs" role="tablist" aria-label="Workout to edit">{WORKOUT_SEQUENCE.map((key) => <button type="button" key={key} role="tab" aria-selected={tab === key} className={tab === key ? `active ${key}` : ""} onClick={() => setTab(key)}>{key}<small>{workouts[key].exercises.length} exercises</small></button>)}</div>
    <PlanExerciseEditor exercises={workouts[tab].exercises} onChange={(exercises) => setWorkouts({ ...workouts, [tab]: { ...workouts[tab], exercises } })} />
    <p className="plan-help">Use a single number or range for sets and reps, e.g. 3–4 sets and 6–10 reps. Every phase keeps the rolling Push → Pull → Legs sequence.</p>
    {error && <p className="form-error" role="alert">{error}</p>}<div className="finish-actions"><button className="primary-action" type="submit">Save and start phase</button><button className="secondary-action" type="button" onClick={onCancel}>Cancel</button></div>
  </form>;
}

export function PlanPanel({ state, sessions, activePhase, onSave }: { state: PlanState; sessions: CompletedWorkout[]; activePhase?: string; onSave: (state: PlanState) => string }) {
  const [template, setTemplate] = useState<TrainingPhase | null>(null);
  const [message, setMessage] = useState("");
  const phase = currentPhase(state);
  return <section className="plan-panel" aria-labelledby="plan-title"><div className="section-heading"><div><span className="eyebrow">Your rolling programme</span><h2 id="plan-title">Training plan</h2></div><p>Adapt the plan as your focus changes.</p></div>
    {template ? <PhaseEditor key={template.id} state={state} template={template} onCancel={() => setTemplate(null)} onSave={(next) => { const error = onSave(next); if (!error) { setTemplate(null); setMessage("New phase saved. It applies to your next workout."); } return error; }} /> : <>
      <article className="phase-current"><span className="eyebrow">Current phase</span><h3>{phase.name}</h3>{phase.purpose && <p>{phase.purpose}</p>}<div className="phase-summary">{WORKOUT_SEQUENCE.map((key) => <div key={key} className={key}><strong>{key}</strong><span>{phase.workouts[key].exercises.length} exercises</span></div>)}</div><button className="primary-action" type="button" onClick={() => { setTemplate(phase); setMessage(""); }}>Edit as a new phase</button>{activePhase && <p className="plan-help">Your in-progress workout keeps “{activePhase}”. Adjustments to this session are available in Train.</p>}</article>
      <p role="status">{message}</p>
      <div className="phase-history"><h3>Phase history</h3>{[...state.phases].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map((item) => {
        const count = sessions.filter((session) => session.training?.phaseId === item.id).length;
        return <details key={item.id}><summary><span><strong>{item.name}</strong><small>{new Date(item.startedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} · {count} recorded workout{count === 1 ? "" : "s"}</small></span>{item.id === state.currentId && <b>Current</b>}</summary>{item.purpose && <p>{item.purpose}</p>}<div className="phase-workouts">{WORKOUT_SEQUENCE.map((key) => <div key={key}><h4>{key}</h4><ol>{item.workouts[key].exercises.map((exercise) => <li key={exercise.name}><strong>{exercise.name}</strong><span>{exercise.sets} × {exercise.reps} · {exercise.priority === "must" ? "Must do" : "If time"}</span></li>)}</ol></div>)}</div><button className="secondary-action" type="button" onClick={() => { setTemplate(item); setMessage(""); }}>Use as a starting point</button></details>;
      })}</div>
    </>}
  </section>;
}

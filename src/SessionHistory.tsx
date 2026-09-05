import { useState } from "react";
import { formatExerciseSets, workoutDurationMinutes, type CompletedWorkout, type ExerciseDefinition } from "./sessionModel";
import { validateSessionEdit } from "./sessionEditing";

function localTime(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}

function SessionEditor({ original, definitions, onSave, onCancel }: {
  original: CompletedWorkout; definitions: ExerciseDefinition[];
  onSave: (original: CompletedWorkout, updated: CompletedWorkout) => string; onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => structuredClone(original));
  const [error, setError] = useState("");
  const [start, setStart] = useState(() => localTime(original.startedAt));
  const [end, setEnd] = useState(() => localTime(original.endedAt));
  const updateExercise = (index: number, sets: CompletedWorkout["exercises"][number]["sets"]) => {
    setDraft({ ...draft, exercises: draft.exercises.map((exercise, i) => i === index ? { ...exercise, sets } : exercise) });
  };
  return <form className="session-editor" onSubmit={(event) => {
    event.preventDefault();
    if (![start, end].every((value) => Number.isFinite(Date.parse(value)))) { setError("Enter a valid start and end time."); return; }
    const result = validateSessionEdit(original, { ...draft, startedAt: start === localTime(original.startedAt) ? original.startedAt : new Date(start).toISOString(), endedAt: end === localTime(original.endedAt) ? original.endedAt : new Date(end).toISOString() });
    if (!result.session) { setError(result.error || "Unable to save session."); return; }
    setError(onSave(original, result.session));
  }}>
    <h3>Edit {original.workout} session</h3>
    <div className="session-fields">
      <label>Started<input type="datetime-local" step="1" required value={start} onChange={(event) => setStart(event.target.value)} /></label>
      <label>Finished<input type="datetime-local" step="1" required value={end} onChange={(event) => setEnd(event.target.value)} /></label>
      <label>Bodyweight (kg)<input inputMode="decimal" value={draft.bodyweight} onChange={(event) => setDraft({ ...draft, bodyweight: event.target.value })} /></label>
    </div>
    <label>Session note<textarea rows={3} value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} /></label>
    {draft.exercises.map((exercise, index) => <fieldset key={exercise.name}><legend>{exercise.name}</legend>
      {exercise.sets.map((set, setIndex) => <div className="session-set" key={set.id ?? setIndex}>
        <span>Set {setIndex + 1}</span>
        <label>Load<input aria-label={`${exercise.name} set ${setIndex + 1} load`} placeholder="kg / BW" value={set.load} onChange={(event) => updateExercise(index, exercise.sets.map((entry, i) => i === setIndex ? { ...entry, load: event.target.value } : entry))} /></label>
        <label>Reps<input aria-label={`${exercise.name} set ${setIndex + 1} reps`} type="number" min="1" step="1" required value={set.reps} onChange={(event) => updateExercise(index, exercise.sets.map((entry, i) => i === setIndex ? { ...entry, reps: event.target.value } : entry))} /></label>
        <button type="button" className="text-action" aria-label={`Remove ${exercise.name} set ${setIndex + 1}`} onClick={() => updateExercise(index, exercise.sets.filter((_, i) => i !== setIndex))}>Remove</button>
      </div>)}
      <button type="button" className="secondary-action" onClick={() => updateExercise(index, [...exercise.sets, { id: crypto.randomUUID(), load: "", reps: "" }])}>Add set</button>
      <button type="button" className="text-action" onClick={() => setDraft({ ...draft, exercises: draft.exercises.filter((_, i) => i !== index) })}>Remove exercise</button>
    </fieldset>)}
    <label>Add exercise<select value="" onChange={(event) => {
      const exercise = definitions.find((item) => item.name === event.target.value);
      if (exercise) setDraft({ ...draft, exercises: [...draft.exercises, { ...exercise, sets: [{ id: crypto.randomUUID(), load: "", reps: "" }] }] });
    }}><option value="">Choose an exercise</option>{definitions.filter((item) => !draft.exercises.some((exercise) => exercise.name === item.name)).map((item) => <option key={item.name}>{item.name}</option>)}</select></label>
    {original.sync.status === "synced" && <p>This edits your Rolling PPL record. The existing Autumn session must be updated separately.</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="finish-actions"><button className="primary-action" type="submit">Save changes</button><button className="secondary-action" type="button" onClick={onCancel}>Cancel editing</button></div>
  </form>;
}

export function SessionHistory({ sessions, definitions, onSave }: {
  sessions: CompletedWorkout[]; definitions: Record<string, ExerciseDefinition[]>;
  onSave: (original: CompletedWorkout, updated: CompletedWorkout) => string;
}) {
  const [editing, setEditing] = useState<CompletedWorkout | null>(null);
  const [limit, setLimit] = useState(10);
  const [message, setMessage] = useState("");
  return <section className="session-history" aria-labelledby="sessions-title"><h2 id="sessions-title">Past sessions</h2>
    <p role="status">{message}</p>
    {editing ? <SessionEditor key={editing.id} original={editing} definitions={definitions[editing.workout]} onCancel={() => setEditing(null)} onSave={(original, updated) => {
      const error = onSave(original, updated);
      if (!error) { setEditing(null); setMessage("Session updated."); }
      return error;
    }} /> : <>
      {!sessions.length && <p>Completed workouts will appear here.</p>}
      {sessions.slice(0, limit).map((session) => <article className="past-session" key={session.id}><div className="past-session-heading"><div><h3>{session.workout} · {new Date(session.startedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</h3><p>{workoutDurationMinutes(session)} min{session.bodyweight ? ` · ${session.bodyweight} kg bodyweight` : ""}</p></div><button className="secondary-action" type="button" disabled={session.sync.status === "syncing"} onClick={() => { setEditing(session); setMessage(""); }}>Edit session</button></div><details><summary>Session details</summary><ul>{session.exercises.map((exercise) => <li key={exercise.name}><strong>{exercise.name}</strong>: {formatExerciseSets(exercise)}</li>)}</ul>{session.note && <p className="session-note">{session.note}</p>}</details></article>)}
      {sessions.length > limit && <button type="button" className="secondary-action" onClick={() => setLimit(limit + 10)}>Show more sessions</button>}
    </>}
  </section>;
}

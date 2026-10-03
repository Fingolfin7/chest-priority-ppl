import { useId, useState } from "react";
import { equipmentOptions, exerciseDefinition, muscleOptions, normalizeExerciseSearch, searchExercises } from "./exerciseLibrary";
import { ExerciseImages } from "./ExerciseImages";
import { validatePlanExercises, type PlanExercise } from "./planModel";

export function ExercisePicker({ catalog, excluded = [], disabled = false, onSelect, prescriptions = false }: {
  catalog: PlanExercise[]; excluded?: string[]; disabled?: boolean; onSelect: (exercise: PlanExercise) => void; prescriptions?: boolean;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [muscle, setMuscle] = useState("");
  const [equipment, setEquipment] = useState("");
  const [limit, setLimit] = useState(30);
  const [preview, setPreview] = useState<PlanExercise | null>(null);
  const [error, setError] = useState("");
  const available = searchExercises(catalog, query, muscle, equipment).filter((exercise) => !excluded.some((name) => normalizeExerciseSearch(name) === normalizeExerciseSearch(exercise.name)));
  const known = Boolean(exerciseDefinition(query)) || catalog.some((exercise) => normalizeExerciseSearch(exercise.name) === normalizeExerciseSearch(query));
  const definition = preview ? exerciseDefinition(preview.name) : undefined;
  const choose = () => {
    if (!preview || disabled) return;
    try { validatePlanExercises([preview]); } catch (caught) { setError(caught instanceof Error ? caught.message : "Check this exercise's sets and reps."); return; }
    onSelect(structuredClone(preview)); setPreview(null); setError("");
  };
  return <div className="exercise-library">
    <label htmlFor={`${id}-search`}>Find an exercise<input id={`${id}-search`} type="search" maxLength={120} value={query} placeholder="Name, muscle or equipment" onChange={(event) => { setQuery(event.target.value); setLimit(30); setPreview(null); }} /></label>
    <div className="exercise-library-filters"><label>Muscle group<select value={muscle} onChange={(event) => { setMuscle(event.target.value); setLimit(30); setPreview(null); }}><option value="">All muscles</option>{muscleOptions.map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label>Equipment<select value={equipment} onChange={(event) => { setEquipment(event.target.value); setLimit(30); setPreview(null); }}><option value="">All equipment</option>{equipmentOptions.map((item) => <option key={item} value={item}>{item === "body only" ? "Bodyweight" : item}</option>)}</select></label></div>
    <p className="exercise-library-count" role="status">{available.length} matching exercise{available.length === 1 ? "" : "s"}</p>
    <div className="exercise-library-results">{available.slice(0, limit).map((exercise) => {
      const info = exerciseDefinition(exercise.name);
      return <button type="button" key={exercise.name} disabled={disabled} aria-pressed={preview?.name === exercise.name} onClick={() => { setPreview(structuredClone(exercise)); setError(""); }}><strong>{exercise.name}</strong><small>{info ? `${info.primaryMuscles.join(", ")} · ${info.equipment === "body only" ? "bodyweight" : info.equipment}` : "Your exercise"}</small><span aria-hidden="true">+</span></button>;
    })}</div>
    {available.length > limit && <button type="button" className="text-action" onClick={() => setLimit(limit + 30)}>Show more exercises</button>}
    {!available.length && <p>No matching exercises. Try another search or clear the filters.</p>}
    {query.trim() && !known && !excluded.some((name) => normalizeExerciseSearch(name) === normalizeExerciseSearch(query)) && <button type="button" className="secondary-action" disabled={disabled} onClick={() => { setPreview({ name: query.trim(), sets: "3", reps: "8–12", rest: "90 sec", warmup: "", cue: "", priority: "must", demos: [] }); setError(""); }}>Create “{query.trim()}”</button>}
    {preview && <section className="exercise-library-preview" aria-label="Exercise preview">
      <div className="exercise-library-preview-heading"><h4>{preview.name}</h4><button className="text-action" type="button" onClick={() => setPreview(null)}>Close preview</button></div>
      {definition && <p>{definition.primaryMuscles.join(", ")} · {definition.equipment} · {definition.category}</p>}
      {preview.demos[0] && <ExerciseImages key={preview.demos[0].slug} slug={preview.demos[0].slug} label={preview.name} />}
      {preview.cue && <p className="exercise-library-cue">{preview.cue}</p>}
      {definition && !["strength", "powerlifting", "strongman", "olympic weightlifting", "plyometrics"].includes(definition.category) && <p>This logger records reps, rather than time or distance.</p>}
      {prescriptions && <div className="exercise-library-prescription"><label>Sets<input maxLength={8} value={preview.sets} onChange={(event) => setPreview({ ...preview, sets: event.target.value })} /></label><label>Rep range<input maxLength={8} value={preview.reps} onChange={(event) => setPreview({ ...preview, reps: event.target.value })} /></label><label>Weight convention<select value={preview.loadSuffix ?? ""} onChange={(event) => setPreview({ ...preview, loadSuffix: event.target.value || undefined })}><option value="">Total weight / machine stack</option><option value=" each">Per dumbbell</option></select></label></div>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary-action" type="button" disabled={disabled} onClick={choose}>Use this exercise</button>
      {!definition && <p className="exercise-library-count">Saved exercises become available again after you save the plan or finish the session.</p>}
    </section>}
  </div>;
}

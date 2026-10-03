import { useState } from "react";
import type { PlanExercise } from "./planModel";
import type { DraftMap } from "./drafts";

export function FreeSessionPicker({ catalog, selected, drafts, nextLabel, onAdd, onRemove }: {
  catalog: PlanExercise[]; selected: PlanExercise[]; drafts: DraftMap; nextLabel: string;
  onAdd: (exercise: PlanExercise) => void; onRemove: (name: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(!selected.length);
  const available = catalog.filter((exercise) => !selected.some((item) => item.name === exercise.name) && exercise.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <section className="free-session-picker" aria-label="Free session exercises">
    <p>Choose exercises as you go. Your usual targets and history carry over. <strong>{nextLabel} stays next.</strong></p>
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Add exercise</summary>
      <div className="free-picker-content">
        <label>Find an exercise<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search your programme" /></label>
        <div className="free-picker-options">{available.map((exercise) => <button type="button" key={exercise.name} disabled={selected.length >= 30} onClick={() => { onAdd(exercise); setSearch(""); setOpen(false); }}><strong>{exercise.name}</strong><small>{exercise.sets} sets · {exercise.reps} reps</small><span aria-hidden="true">+</span></button>)}</div>
        {!available.length && <p>{search ? "No matching exercises." : "All programme exercises have been added."}</p>}
      </div>
    </details>
    {selected.length > 0 && <div className="free-selected">{selected.map((exercise) => {
      const entered = (drafts[exercise.name] ?? []).some((set) => set.load.trim() || set.reps.trim());
      return <button type="button" key={exercise.name} disabled={entered} title={entered ? "Clear this exercise's sets before removing it." : "Remove from this session"} aria-label={`Remove ${exercise.name}`} onClick={() => onRemove(exercise.name)}>{exercise.name}<span aria-hidden="true"> ×</span></button>;
    })}<small>Exercises with entered sets stay in the session. Clear their sets to remove them.</small></div>}
    {!selected.length && <p className="free-session-empty">Add your first exercise to start logging.</p>}
  </section>;
}

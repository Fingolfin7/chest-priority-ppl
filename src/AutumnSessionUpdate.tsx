import { useRef, useState } from "react";
import {
  applyAutumnWorkoutUpdate, buildAutumnWorkoutUpdatePatch, readAutumnWorkoutUpdate,
  type AutumnSettings, type AutumnUpdateField, type AutumnUpdatePreview,
} from "./autumn";
import type { CompletedWorkout } from "./sessionModel";

type Review = {
  kind: "review" | "saving";
  preview: AutumnUpdatePreview;
  selected: AutumnUpdateField[];
  note: string;
};
type UpdateState = Review | { kind: "idle"; message: string } | { kind: "error"; message: string } | { kind: "loading" };

const labels = { start: "Start time", end: "Finish time", note: "Workout note" };

function displayedTime(value: string) {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

export function AutumnSessionUpdate({ session, settings, getSession }: {
  session: CompletedWorkout;
  settings: AutumnSettings;
  getSession: (id: string) => CompletedWorkout | undefined;
}) {
  const [state, setState] = useState<UpdateState>({ kind: "idle", message: "" });
  const busy = useRef(false);

  const close = () => setState({ kind: "idle", message: "" });
  const load = async () => {
    if (busy.current) return;
    busy.current = true;
    setState({ kind: "loading" });
    try {
      const current = getSession(session.id);
      if (!current) throw new Error("This workout is no longer in your history.");
      const preview = await readAutumnWorkoutUpdate(settings, current);
      setState({ kind: "review", preview, selected: [], note: preview.after.note });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "Could not load the Autumn session." });
    } finally {
      busy.current = false;
    }
  };

  const save = async (review: Review) => {
    if (busy.current) return;
    busy.current = true;
    setState({ ...review, kind: "saving" });
    try {
      await applyAutumnWorkoutUpdate(settings, getSession(session.id), review.preview, review.selected, review.note);
      setState({ kind: "idle", message: "Autumn session updated." });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "Could not update the Autumn session." });
    } finally {
      busy.current = false;
    }
  };

  if (state.kind === "idle") {
    return <div className="autumn-session-action">
      <button className="text-action" type="button" onClick={load}>Update in Autumn</button>
      {state.message && <p role="status">{state.message}</p>}
    </div>;
  }
  if (state.kind === "loading") return <p role="status">Loading the Autumn session…</p>;
  if (state.kind === "error") {
    return <div className="autumn-session-update">
      <p className="form-error" role="alert">{state.message}</p>
      <div className="finish-actions">
        {settings.token && <button className="secondary-action" type="button" onClick={load}>Refresh preview</button>}
        <button className="text-action" type="button" onClick={close}>Close</button>
      </div>
    </div>;
  }

  const { preview, selected, note } = state;
  if (!preview.fields.length) {
    return <div className="autumn-session-update">
      <p role="status">The linked Autumn session already matches this workout.</p>
      <button className="text-action" type="button" onClick={close}>Close</button>
    </div>;
  }
  const patch = buildAutumnWorkoutUpdatePatch(preview, selected, note);
  const invalidRange = Date.parse(patch.end ?? preview.before.end) < Date.parse(patch.start ?? preview.before.start);
  const saving = state.kind === "saving";

  return <form className="autumn-session-update" onSubmit={(event) => {
    event.preventDefault();
    if (!invalidRange && Object.keys(patch).length) void save(state);
  }}>
    <h4>Update Autumn{preview.projectName ? ` · ${preview.projectName}` : ""}</h4>
    <p>Choose what to send. Any unchecked fields keep their current Autumn values.</p>
    {preview.fields.map((field) => <fieldset key={field} disabled={saving}>
      <legend>{labels[field]}</legend>
      <label className="autumn-change-toggle">
        <input type="checkbox" checked={selected.includes(field)} onChange={(event) => setState({
          ...state, selected: event.target.checked ? [...selected, field] : selected.filter((value) => value !== field),
        })} />
        Update {labels[field].toLowerCase()}
      </label>
      <div className="autumn-change-values">
        <div><span>Current Autumn value</span>
          {field === "note" ? <pre>{preview.before.note || "No note"}</pre> : <time dateTime={preview.before[field]}>{displayedTime(preview.before[field])}</time>}
        </div>
        {field === "note" ? <label><span>Note to send</span>
          <textarea rows={6} value={note} readOnly={!selected.includes("note")} onChange={(event) => setState({ ...state, note: event.target.value })} />
        </label> : <div><span>Rolling PPL value</span><time dateTime={preview.after[field]}>{displayedTime(preview.after[field])}</time></div>}
      </div>
    </fieldset>)}
    {invalidRange && <p className="form-error" role="status">The selected changes would end the session before it starts.</p>}
    <div className="finish-actions">
      <button className="primary-action" type="submit" disabled={saving || invalidRange || !Object.keys(patch).length}>{saving ? "Updating…" : "Apply selected changes"}</button>
      <button className="secondary-action" type="button" disabled={saving} onClick={close}>Cancel</button>
    </div>
  </form>;
}

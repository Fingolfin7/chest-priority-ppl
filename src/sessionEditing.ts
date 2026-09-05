import { completeWorkout, type CompletedWorkout } from "./sessionModel.ts";

export function validateSessionEdit(original: CompletedWorkout, draft: CompletedWorkout) {
  if (original.sync.status === "syncing") return { error: "Wait for Autumn sync to finish before editing." };
  if (![draft.startedAt, draft.endedAt].every((value) => Number.isFinite(Date.parse(value)))) {
    return { error: "Enter a valid start and end time." };
  }
  const result = completeWorkout({
    active: { id: original.id, workout: original.workout, startedAt: draft.startedAt },
    endedAt: draft.endedAt, bodyweight: draft.bodyweight, note: draft.note,
    definitions: draft.exercises.map(({ name, priority, loadSuffix }) => ({ name, priority, ...(loadSuffix ? { loadSuffix } : {}) })),
    drafts: Object.fromEntries(draft.exercises.map((exercise) => [exercise.name, exercise.sets])),
  });
  if (!result.session) return result;
  // Keep the external receipt: resubmitting a POST could duplicate the session.
  return { session: { ...result.session, sync: original.sync } };
}

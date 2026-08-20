import { canonicalExerciseName, type HistoryMap, type SetEntry } from "./historyMigration.ts";

export type DraftMap = Record<string, SetEntry[]>;

function matchesLatestSession(draft: SetEntry[], history: HistoryMap[string]) {
  const latest = history?.[0];
  if (!latest) return false;
  const filledEntries = draft
    .filter((entry) => entry.load.trim() || entry.reps.trim())
    .map((entry) => ({ load: entry.load.trim(), reps: entry.reps.trim() }));
  return filledEntries.length === latest.sets.length
    && filledEntries.every((entry, index) => entry.load === latest.sets[index].load.trim() && entry.reps === latest.sets[index].reps.trim());
}

export function pruneCompletedDrafts(drafts: DraftMap, history: HistoryMap): DraftMap {
  const pruned: DraftMap = {};
  Object.entries(drafts).forEach(([storedExercise, draft]) => {
    if (!Array.isArray(draft) || draft.length === 0) return;
    const exercise = canonicalExerciseName(storedExercise);
    if (matchesLatestSession(draft, history[exercise])) return;
    if (!(exercise in pruned) || storedExercise === exercise) pruned[exercise] = draft;
  });
  return pruned;
}

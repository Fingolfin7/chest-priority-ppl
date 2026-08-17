export type SetEntry = { load: string; reps: string };
export type SavedSession = { id: string; savedAt: string; sets: SetEntry[] };
export type HistoryMap = Record<string, SavedSession[]>;

const EXERCISE_NAME_ALIASES: Record<string, string> = {
  "Rear-delt fly or face pull": "Rear-delt fly",
};

export function canonicalExerciseName(name: string) {
  const trimmed = name.trim();
  return EXERCISE_NAME_ALIASES[trimmed] ?? trimmed;
}

export function canonicalizeHistory(history: HistoryMap): HistoryMap {
  const migrated: HistoryMap = {};
  Object.entries(history).forEach(([storedName, sessions]) => {
    if (!Array.isArray(sessions)) return;
    const exercise = canonicalExerciseName(storedName);
    const byId = new Map((migrated[exercise] ?? []).map((session) => [session.id, session]));
    sessions.forEach((session) => byId.set(session.id, session));
    migrated[exercise] = Array.from(byId.values())
      .sort((left, right) => right.savedAt.localeCompare(left.savedAt))
      .slice(0, 20);
  });
  return migrated;
}

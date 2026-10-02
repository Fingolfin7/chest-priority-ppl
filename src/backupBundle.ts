import { createSyncDoc, projectSyncDoc, type SyncSnapshot } from './peerSyncModel.ts';
import { mergePlanStates } from './planModel.ts';

export const FULL_BACKUP_SCHEMA = 'rolling-ppl-complete-backup';
export const MAX_FULL_BACKUP_BYTES = 300 * 1024 * 1024;

// Round-trip through the same strict schema used for incoming device changes.
// This also excludes credentials, pairing keys, and unknown properties.
export function validateBackupSnapshot(value: unknown): SyncSnapshot {
  try {
    return projectSyncDoc(createSyncDoc(value as SyncSnapshot));
  } catch {
    throw new Error('The workout or programme data in this backup is invalid. Nothing has been restored.');
  }
}

export function mergeBackupSnapshot(current: SyncSnapshot, incoming: SyncSnapshot): SyncSnapshot {
  const completed = new Map(current.completed.map((item) => [item.id, item]));
  incoming.completed.forEach((item) => completed.set(item.id, item));
  const history = { ...current.history };
  for (const [name, entries] of Object.entries(incoming.history)) {
    const merged = new Map((history[name] ?? []).map((item) => [item.id, item]));
    entries.forEach((item) => merged.set(item.id, item));
    history[name] = [...merged.values()].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }
  const empty = !current.completed.length && !Object.keys(current.history).length && !current.activeWorkout && !Object.keys(current.drafts).length;
  return {
    ...(empty ? incoming : current),
    completed: [...completed.values()].sort((a, b) => b.endedAt.localeCompare(a.endedAt)),
    history,
    planState: mergePlanStates(current.planState, incoming.planState),
  };
}

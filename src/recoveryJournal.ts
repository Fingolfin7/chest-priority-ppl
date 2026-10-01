import type { SyncSnapshot } from "./peerSyncModel.ts";

export type RecoveryJournal = { before: Partial<SyncSnapshot>; after: Partial<SyncSnapshot> };

// Keep the synchronous crash journal proportional to the edited fields. Older
// full-snapshot journals use this same shape and remain readable.
export function recoveryJournal(before: SyncSnapshot, after: SyncSnapshot): RecoveryJournal {
  const changed = (Object.keys(after) as Array<keyof SyncSnapshot>).filter((key) => before[key] !== after[key]);
  return {
    before: Object.fromEntries(changed.map((key) => [key, before[key]])),
    after: Object.fromEntries(changed.map((key) => [key, after[key]])),
  };
}

export function recoverySnapshots(baseline: SyncSnapshot, journal: RecoveryJournal) {
  return { before: { ...baseline, ...journal.before }, after: { ...baseline, ...journal.after } };
}

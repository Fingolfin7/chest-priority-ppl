import type { PeerSyncManager } from "./peerSyncManager";
import { exportBodyProgress, importBodyProgress, parseBodyProgress, type BodyProgressData } from "./bodyProgressModel";
import { exportProgressPhotos, importProgressPhotos, parseProgressPhotoBackup, type PhotoProgressBackup } from "./photoStorage";
import { FULL_BACKUP_SCHEMA, mergeBackupSnapshot, validateBackupSnapshot } from "./backupBundle";
import type { SyncSnapshot } from "./peerSyncModel";
import { exportForecastHistory, importForecastHistory, parseForecastHistory, type ForecastHistoryBackup } from "./forecastHistory";

// One format for downloaded files and cloud records copies, so either can be
// restored through the same checks.
export type CompleteBackup = { schema: typeof FULL_BACKUP_SCHEMA; version: 1; exportedAt: string; photosIncluded: boolean; snapshot: SyncSnapshot; body: BodyProgressData; photos: PhotoProgressBackup; forecastHistory: ForecastHistoryBackup };
export type ReadyBackup = { snapshot: SyncSnapshot; body: BodyProgressData; photos: PhotoProgressBackup; photosIncluded: boolean; forecastHistory?: ForecastHistoryBackup };

export async function createCompleteBackup(manager: PeerSyncManager, includePhotos: boolean): Promise<CompleteBackup> {
  manager.flushPendingInputs();
  const snapshot = validateBackupSnapshot(manager.getSnapshot());
  const body = await exportBodyProgress();
  const forecastHistory = await exportForecastHistory();
  const photos = includePhotos ? await exportProgressPhotos() : { schema: "rolling-ppl-progress-photos" as const, version: 1 as const, photos: [] };
  return { schema: FULL_BACKUP_SCHEMA, version: 1, exportedAt: new Date().toISOString(), photosIncluded: includePhotos, snapshot, body, photos, forecastHistory };
}

export function parseCompleteBackup(value: unknown): ReadyBackup {
  const backup = value as Partial<CompleteBackup> | null;
  if (!backup || backup.schema !== FULL_BACKUP_SCHEMA || backup.version !== 1) throw new Error("This is not a complete backup. Use Restore → Workout history for JSON or CSV exports.");
  return {
    snapshot: validateBackupSnapshot(backup.snapshot),
    body: parseBodyProgress(backup.body),
    photos: parseProgressPhotoBackup(backup.photos),
    photosIncluded: backup.photosIncluded !== false,
    forecastHistory: backup.forecastHistory === undefined ? undefined : parseForecastHistory(backup.forecastHistory),
  };
}

export async function restoreCompleteBackup(manager: PeerSyncManager, ready: ReadyBackup) {
  validateBackupSnapshot(mergeBackupSnapshot(manager.getSnapshot(), ready.snapshot));
  await importProgressPhotos(ready.photos);
  await importBodyProgress(ready.body);
  manager.change(mergeBackupSnapshot(manager.getSnapshot(), ready.snapshot));
  await manager.saveNow();
  if (ready.forecastHistory) await importForecastHistory(ready.forecastHistory);
}

export function describeBackup(ready: ReadyBackup) {
  return `${ready.snapshot.completed.length} workouts · ${ready.snapshot.nutrition?.days.length ?? 0} food days · ${ready.body.weighIns.length} weigh-ins · ${ready.body.measurements.length} measurements · ${ready.photos.photos.length} photos · ${ready.forecastHistory?.snapshots.length ?? 0} saved forecasts`;
}

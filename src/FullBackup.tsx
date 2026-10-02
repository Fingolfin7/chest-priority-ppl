import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { PeerSyncManager } from "./peerSyncManager";
import { exportBodyProgress, importBodyProgress, parseBodyProgress, type BodyProgressData } from "./bodyProgressModel";
import { exportProgressPhotos, importProgressPhotos, parseProgressPhotoBackup, type PhotoProgressBackup } from "./photoStorage";
import { FULL_BACKUP_SCHEMA, MAX_FULL_BACKUP_BYTES, mergeBackupSnapshot, validateBackupSnapshot } from "./backupBundle";
import { downloadBackup } from "./transfer";
import type { SyncSnapshot } from "./peerSyncModel";
import { exportForecastHistory, importForecastHistory, parseForecastHistory, type ForecastHistoryBackup } from "./forecastHistory";
import "./fullBackup.css";

type ReadyBackup = { snapshot: SyncSnapshot; body: BodyProgressData; photos: PhotoProgressBackup; photosIncluded: boolean; forecastHistory?: ForecastHistoryBackup };
const LAST_EXPORT = "rolling-ppl-last-complete-export";

export function FullBackup({ manager, embedded = false, mode = "backup", hidden = false }: {
  manager: PeerSyncManager;
  embedded?: boolean;
  mode?: "backup" | "restore";
  hidden?: boolean;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [ready, setReady] = useState<ReadyBackup | null>(null);
  const [includePhotos, setIncludePhotos] = useState(true);
  const [lastExport, setLastExport] = useState(() => { try { return localStorage.getItem(LAST_EXPORT) ?? ""; } catch { return ""; } });

  useEffect(() => {
    if (embedded) return;
    const outside = (event: PointerEvent) => { if (menu.current?.open && !menu.current.contains(event.target as Node)) menu.current.open = false; };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && menu.current?.open) { menu.current.open = false; menu.current.querySelector("summary")?.focus(); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [embedded]);

  async function download() {
    setBusy(true);
    setNotice("Preparing your backup…");
    try {
      manager.flushPendingInputs();
      const snapshot = validateBackupSnapshot(manager.getSnapshot());
      const body = await exportBodyProgress();
      const forecastHistory = await exportForecastHistory();
      const photos = includePhotos ? await exportProgressPhotos() : { schema: "rolling-ppl-progress-photos", version: 1, photos: [] as const };
      const exportedAt = new Date().toISOString();
      const file = new File([JSON.stringify({ schema: FULL_BACKUP_SCHEMA, version: 1, exportedAt, photosIncluded: includePhotos, snapshot, body, photos, forecastHistory })], `rolling-ppl-${includePhotos ? "complete" : "records"}-${exportedAt.slice(0, 10)}.json`, { type: "application/json" });
      if (file.size > MAX_FULL_BACKUP_BYTES) throw new Error("This complete backup is too large for one file. Download a records backup, then export photos in smaller view or date groups from Progress → Photos.");
      downloadBackup(file);
      try { localStorage.setItem(LAST_EXPORT, exportedAt); } catch { /* The download does not depend on this preference. */ }
      setLastExport(exportedAt);
      setNotice(`Download started. Keep a copy outside this browser. ${includePhotos ? "It includes your private photos." : "It contains records only; export photos separately from Progress → Photos."}`);
    } catch (error) {
      if (includePhotos && error instanceof Error && /selection|too large for a photo backup/i.test(error.message)) {
        setNotice("All photos will not fit in one file. Download a records backup, then export photos in smaller view or date groups from Progress → Photos.");
      } else {
        setNotice(error instanceof Error ? error.message : "Backup could not be prepared. Your data is unchanged.");
      }
    } finally { setBusy(false); }
  }

  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setReady(null);
    setNotice("Checking the backup…");
    try {
      if (file.size > MAX_FULL_BACKUP_BYTES) throw new Error("Choose a complete backup smaller than 300 MB.");
      const value = JSON.parse(await file.text());
      if (!value || value.schema !== FULL_BACKUP_SCHEMA || value.version !== 1) throw new Error("This is not a complete backup. Use Restore → Workout history for JSON or CSV exports.");
      const snapshot = validateBackupSnapshot(value.snapshot);
      const body = parseBodyProgress(value.body);
      const photos = parseProgressPhotoBackup(value.photos);
      const forecastHistory = value.forecastHistory === undefined ? undefined : parseForecastHistory(value.forecastHistory);
      setReady({ snapshot, body, photos, photosIncluded: value.photosIncluded !== false, forecastHistory });
      setNotice("Backup checked. Review its contents before restoring.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "This backup could not be read. Nothing has changed.");
    } finally { setBusy(false); }
  }

  async function restore() {
    if (!ready) return;
    setBusy(true);
    setNotice("Restoring the backup. Keep this page open…");
    try {
      validateBackupSnapshot(mergeBackupSnapshot(manager.getSnapshot(), ready.snapshot));
      await importProgressPhotos(ready.photos);
      await importBodyProgress(ready.body);
      manager.change(mergeBackupSnapshot(manager.getSnapshot(), ready.snapshot));
      await manager.saveNow();
      if (ready.forecastHistory) await importForecastHistory(ready.forecastHistory);
      setReady(null);
      setNotice("Backup restored. Existing unrelated records were kept. Photos save locally; enabled photo backup can also upload restored photos.");
    } catch (error) {
      setNotice(`Restore could not finish: ${error instanceof Error ? error.message : String(error)}. Some records may already have been restored; it is safe to retry the same backup.`);
    } finally { setBusy(false); }
  }

  const content = <div className={`complete-backup-panel${embedded ? " embedded" : ""}`} hidden={hidden} aria-label={mode === "backup" ? "Complete backup" : "Restore a complete backup"}>
    {mode === "backup" ? <>
      <h2>Complete backup</h2>
      <p>One file with workouts, plans, body records, saved forecasts, and private photos.</p>
      <label className="backup-photo-choice"><input type="checkbox" checked={includePhotos} disabled={busy} onChange={(event) => setIncludePhotos(event.target.checked)} />Include private photos</label>
      {!includePhotos && <p className="backup-small">Records only. For photos, open Progress → Photos → Storage and photo backups.</p>}
      <button type="button" className="primary-action" disabled={busy} onClick={() => void download()}>{includePhotos ? "Download complete backup" : "Download records backup"}</button>
      <p className="backup-small">{lastExport ? `Last download started ${new Date(lastExport).toLocaleString()}.` : "No complete backup downloaded on this device yet."}</p>
      <details className="backup-details"><summary>What is included?</summary><p>Workout records, body records and saved forecasts are included. Account credentials and device pairing keys are left out. Photos are included only when selected; optional cloud photo backup is managed separately in Progress → Photos.</p></details>
    </> : <>
      <h2>Restore a complete backup</h2>
      <p>Choose a complete Rolling PPL backup. Review the contents before you restore it.</p>
      <label className="backup-file">Choose complete backup<input type="file" accept=".json,.txt,application/json" disabled={busy} onChange={(event) => void choose(event)} /></label>
      {ready && <div className="backup-preview">
        <strong>Ready to restore</strong>
        <p>{ready.snapshot.completed.length} workouts · {ready.body.weighIns.length} weigh-ins · {ready.body.measurements.length} measurements · {ready.photos.photos.length} photos · {ready.forecastHistory?.snapshots.length ?? 0} saved forecasts</p>
        {!ready.photosIncluded && <p>Photos were not included; existing photos on this device will stay intact.</p>}
        <p>Matching workout IDs use the backup copy. Body records use their latest saved version. Your current workout and plan stay selected if this browser already has training history.</p>
        <button type="button" className="primary-action" disabled={busy} onClick={() => void restore()}>Restore this backup</button>
        <button type="button" className="secondary-action" disabled={busy} onClick={() => { setReady(null); setNotice("Restore canceled."); }}>Cancel</button>
      </div>}
    </>}
    {busy && <p role="status" className="backup-notice">{notice}</p>}
    {!busy && notice && <p role="status" className="backup-notice">{notice}</p>}
  </div>;

  if (embedded) return content;
  return <details className="complete-backup" ref={menu}>
    <summary>Backup</summary>
    {content}
  </details>;
}

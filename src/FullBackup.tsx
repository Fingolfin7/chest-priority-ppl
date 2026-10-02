import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { PeerSyncManager } from './peerSyncManager';
import { exportBodyProgress, importBodyProgress, parseBodyProgress, type BodyProgressData } from './bodyProgressModel';
import { exportProgressPhotos, importProgressPhotos, parseProgressPhotoBackup, type PhotoProgressBackup } from './photoStorage';
import { FULL_BACKUP_SCHEMA, MAX_FULL_BACKUP_BYTES, mergeBackupSnapshot, validateBackupSnapshot } from './backupBundle';
import { downloadBackup } from './transfer';
import type { SyncSnapshot } from './peerSyncModel';
import './fullBackup.css';

type ReadyBackup = { snapshot: SyncSnapshot; body: BodyProgressData; photos: PhotoProgressBackup; photosIncluded: boolean };
const LAST_EXPORT = 'rolling-ppl-last-complete-export';

export function FullBackup({ manager }: { manager: PeerSyncManager }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [ready, setReady] = useState<ReadyBackup | null>(null);
  const [includePhotos, setIncludePhotos] = useState(true);
  const [lastExport, setLastExport] = useState(() => { try { return localStorage.getItem(LAST_EXPORT) ?? ''; } catch { return ''; } });
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (menu.current?.open && !menu.current.contains(event.target as Node)) menu.current.open = false; };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && menu.current?.open) { menu.current.open = false; menu.current.querySelector('summary')?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, []);

  async function download() {
    setBusy(true); setNotice('Preparing your photos and records…');
    try {
      manager.flushPendingInputs();
      const snapshot = validateBackupSnapshot(manager.getSnapshot());
      const body = await exportBodyProgress();
      const photos = includePhotos ? await exportProgressPhotos() : {schema: 'rolling-ppl-progress-photos', version: 1, photos: []};
      const exportedAt = new Date().toISOString();
      const file = new File([JSON.stringify({ schema: FULL_BACKUP_SCHEMA, version: 1, exportedAt, photosIncluded: includePhotos, snapshot, body, photos })], `rolling-ppl-${includePhotos ? 'complete' : 'records'}-${exportedAt.slice(0, 10)}.json`, { type: 'application/json' });
      if (file.size > MAX_FULL_BACKUP_BYTES) throw new Error('This backup is too large for one file. Turn off Include private photos to back up your records separately.');
      downloadBackup(file);
      try { localStorage.setItem(LAST_EXPORT, exportedAt); } catch { /* Download does not depend on preferences. */ }
      setLastExport(exportedAt);
      setNotice(`Download started. Keep this file somewhere outside this browser. ${includePhotos ? 'It contains your private photos;' : 'Photos are excluded; keep a separate photo backup and'} confirm the download finished.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Backup could not be prepared. Your data is unchanged.'); }
    finally { setBusy(false); }
  }

  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    setBusy(true); setReady(null); setNotice('Checking the backup…');
    try {
      if (file.size > MAX_FULL_BACKUP_BYTES) throw new Error('Choose a complete backup smaller than 300 MB.');
      const value = JSON.parse(await file.text());
      if (!value || value.schema !== FULL_BACKUP_SCHEMA || value.version !== 1) throw new Error('Choose a Rolling PPL complete backup. Use Data to restore workout-only exports.');
      const snapshot = validateBackupSnapshot(value.snapshot);
      const body = parseBodyProgress(value.body);
      const photos = parseProgressPhotoBackup(value.photos);
      setReady({ snapshot, body, photos, photosIncluded: value.photosIncluded !== false }); setNotice('Backup checked. Review the contents below before restoring.');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'This backup could not be read. Nothing has changed.'); }
    finally { setBusy(false); }
  }

  async function restore() {
    if (!ready) return;
    setBusy(true); setNotice('Restoring the backup. Keep this page open…');
    try {
      // Validate the combined workout state before making any persistent writes.
      validateBackupSnapshot(mergeBackupSnapshot(manager.getSnapshot(), ready.snapshot));
      await importProgressPhotos(ready.photos);
      await importBodyProgress(ready.body);
      manager.change(mergeBackupSnapshot(manager.getSnapshot(), ready.snapshot));
      await manager.saveNow();
      setReady(null); setNotice('Backup restored. Existing unrelated records were kept. Photos remain private to this browser.');
    } catch (error) {
      setNotice(`Restore could not finish: ${error instanceof Error ? error.message : String(error)}. Some records may already have been restored; it is safe to retry the same backup.`);
    } finally { setBusy(false); }
  }

  return <details className="complete-backup" ref={menu}>
    <summary>Backup</summary>
    <div className="complete-backup-panel">
      <h2>Back up this app</h2>
      <p>One file with workouts, plans, weigh-ins, goals, measurements, and private photos. Account credentials and device pairing keys are excluded.</p>
      <p className="backup-small">{lastExport ? `Last download started ${new Date(lastExport).toLocaleString()}.` : 'No complete backup downloaded on this device yet.'}</p>
      <label className="backup-photo-choice"><input type="checkbox" checked={includePhotos} disabled={busy} onChange={(event) => setIncludePhotos(event.target.checked)} />Include private photos</label>
      {!includePhotos && <p className="backup-small">This file will contain training and body records only. Back up your photos separately in Progress → Photos.</p>}
      <button type="button" className="primary-action" disabled={busy} onClick={() => void download()}>{includePhotos ? 'Download complete backup' : 'Download records backup'}</button>
      <label className="backup-file">Choose a backup to restore<input type="file" accept=".json,.txt,application/json" disabled={busy} onChange={(event) => void choose(event)} /></label>
      {ready && <div className="backup-preview">
        <strong>Ready to restore</strong>
        <p>{ready.snapshot.completed.length} workouts · {ready.body.weighIns.length} weigh-ins · {ready.body.measurements.length} measurements · {ready.photos.photos.length} photos</p>
        {!ready.photosIncluded && <p>Photos were excluded from this backup. Existing photos on this device will stay intact.</p>}
        <p>Matching workout IDs use the backup copy. Body records use their latest saved version. Your current workout and current plan stay selected if this browser already has training history.</p>
        <button type="button" className="primary-action" disabled={busy} onClick={() => void restore()}>Restore this backup</button>
        <button type="button" className="secondary-action" disabled={busy} onClick={() => { setReady(null); setNotice('Restore cancelled.'); }}>Cancel</button>
      </div>}
      {notice && <p role="status" className="backup-notice">{notice}</p>}
    </div>
  </details>;
}

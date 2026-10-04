import { useEffect, useSyncExternalStore } from "react";
import {
  associateExistingCloudPhotos, disconnectCloudPhotoBackup, enableCloudPhotoBackup,
  getCloudPhotoBackupState, initializeCloudPhotoBackup, pauseCloudPhotoBackup,
  recoverCloudPhotos, signInAgainCloudPhotoBackup, subscribeCloudPhotoBackup, syncCloudPhotos,
} from "./cloudPhotoBackup";
import type { ProgressPhoto } from "./photoStorage";
import "./cloudPhotoBackup.css";

export function useCloudPhotoBackup() {
  return useSyncExternalStore(subscribeCloudPhotoBackup, getCloudPhotoBackupState, getCloudPhotoBackupState);
}

export function CloudPhotoBackupPanel({ photos }: { photos: ProgressPhoto[] }) {
  const state = useCloudPhotoBackup();
  const unassociated = photos.filter((photo) => !photo.cloud).length;
  const pending = photos.filter((photo) => photo.cloud?.owner === state.owner && photo.cloud?.status === "pending").length;
  const backedUp = photos.filter((photo) => photo.cloud?.owner === state.owner && photo.cloud?.status === "backed-up").length;
  useEffect(() => { void initializeCloudPhotoBackup(); }, []);
  return <section className="cloud-photo-backup" aria-labelledby="cloud-photo-backup-title">
    <div className="cloud-photo-heading"><div><h3 id="cloud-photo-backup-title">Cloud backup</h3><p>Private copies you can recover after clearing browser data or switching devices.</p></div>
      <span className="cloud-photo-state">{!state.ready ? "Checking availability…" : !state.available ? "Unavailable" : state.syncing ? "Syncing…" : state.enabled && state.signedIn ? "Enabled" : "Off"}</span>
    </div>
    {!state.ready ? null : !state.available ? <p>Not available yet. Photos stay on this device and Complete Backup still includes them.</p> : <>
      {!state.signedIn ? <><p>Sign in once and new photos upload automatically when online. Existing photos need your approval.</p><button type="button" className="primary-action" onClick={() => void enableCloudPhotoBackup()}>Enable backup &amp; sign in</button></> : <>
        <p>Signed in{state.email ? ` as ${state.email}` : " to your private photo account"}. {state.enabled ? "New photos back up automatically." : "Automatic backup is paused."}</p>
        {state.enabled && <p className="cloud-photo-counts">{backedUp} backed up · {pending} pending · {state.cloudCount} in your cloud collection</p>}
        {pending > 0 && <p>Pending photos retry when you reconnect and cannot be recovered until uploaded. Keep this browser&apos;s data until they show “Backed up”.</p>}
        {state.deletionCount > 0 && <p role="status">{state.deletionCount} cloud {state.deletionCount === 1 ? "deletion is" : "deletions are"} pending. Reconnect with backup enabled to finish.</p>}
        <div className="cloud-photo-actions">
          {state.enabled ? <><button type="button" onClick={() => void syncCloudPhotos()} disabled={state.syncing}>Retry backup</button><button type="button" className="text-action" onClick={pauseCloudPhotoBackup}>Pause backup</button></> : <button type="button" className="primary-action" onClick={() => void enableCloudPhotoBackup()}>Enable automatic backup</button>}
          <button type="button" className="text-action" onClick={() => void disconnectCloudPhotoBackup()}>Sign out</button>
        </div>
        {state.enabled && unassociated > 0 && <div className="cloud-photo-existing"><p>{unassociated} {unassociated === 1 ? "photo is" : "photos are"} only on this device.</p><button type="button" onClick={() => void associateExistingCloudPhotos()} disabled={state.syncing}>Back up {unassociated} existing {unassociated === 1 ? "photo" : "photos"}</button></div>}
        {state.enabled && state.recoverableCount > 0 && <div className="cloud-photo-existing"><p>{state.recoverableCount} backed-up {state.recoverableCount === 1 ? "photo" : "photos"} (including any removed here) can be restored to this device.</p><button type="button" className="primary-action" onClick={() => void recoverCloudPhotos()} disabled={state.syncing}>Recover {state.recoverableCount} {state.recoverableCount === 1 ? "photo" : "photos"}</button></div>}
      </>}
      <p className="cloud-photo-privacy">Cloud copies are private to your account. Signing out keeps device copies; photos from another account are never added automatically.</p>
    </>}
    {state.error && <><p className="photo-progress-error" role="alert">{state.error}</p>{state.signedIn && <button type="button" onClick={() => void signInAgainCloudPhotoBackup()}>Sign in again</button>}</>}
  </section>;
}

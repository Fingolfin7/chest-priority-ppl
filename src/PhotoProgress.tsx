import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  exportProgressPhotos,
  getProgressPhotoStorageInfo,
  getProgressPhotos,
  importProgressPhotos,
  PHOTO_BACKUP_MAX_BYTES,
  PHOTO_PROGRESS_CHANGE_EVENT,
  parseProgressPhotoBackup,
  requestProgressPhotoPersistence,
  saveProgressPhoto,
  type ProgressPhoto,
  type ProgressPhotoView,
} from "./photoStorage";
import "./photoProgress.css";
import { CloudPhotoBackupPanel, useCloudPhotoBackup } from "./CloudPhotoBackupPanel";
import { cloudPhotoStatus, removePhotoWithCloudChoice } from "./cloudPhotoBackup";

const VIEWS: ProgressPhotoView[] = ["front", "side", "back"];
const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function viewLabel(view: ProgressPhotoView) {
  return view[0].toUpperCase() + view.slice(1);
}

function todayLocal() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function displayDate(value: string) {
  return new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatBytes(value?: number) {
  if (value === undefined || !Number.isFinite(value)) return "Not reported";
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function asErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Photo storage could not complete that action.";
}

export function PhotoProgress() {
  const cloudBackup = useCloudPhotoBackup();
  const [photos, setPhotos] = useState<ProgressPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [storageError, setStorageError] = useState("");
  const [status, setStatus] = useState("");
  const [photoDate, setPhotoDate] = useState(todayLocal);
  const [importView, setImportView] = useState<ProgressPhotoView>("front");
  const [filterView, setFilterView] = useState<"all" | ProgressPhotoView>("all");
  const [backupFromDate, setBackupFromDate] = useState("");
  const [backupThroughDate, setBackupThroughDate] = useState("");
  const [storageInfo, setStorageInfo] = useState<{ usage?: number; quota?: number; persisted: boolean }>({ persisted: false });
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [cameraStarting, setCameraStarting] = useState(false);
  const [cameraStep, setCameraStep] = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProgressPhoto | null>(null);
  const [deleteCloudCopy, setDeleteCloudCopy] = useState(false);
  const [previewPhoto, setPreviewPhoto] = useState<ProgressPhoto | null>(null);
  const [compareView, setCompareView] = useState<ProgressPhotoView>("front");
  const [beforeId, setBeforeId] = useState("");
  const [afterId, setAfterId] = useState("");
  const [photoUrls, setPhotoUrls] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraRequestRef = useRef(0);
  const mountedRef = useRef(false);
  const photoUrlsRef = useRef<Map<string, string>>(new Map());
  const refreshRequestRef = useRef(0);
  const dialogRef = useRef<HTMLElement>(null);
  const dialogActionRef = useRef<HTMLButtonElement>(null);
  const focusReturnRef = useRef<HTMLElement | null>(null);
  const galleryHeadingRef = useRef<HTMLHeadingElement>(null);
  const activeDialog = pendingDelete ? "delete" : previewPhoto ? "preview" : null;

  const refresh = useCallback(async () => {
    const requestId = ++refreshRequestRef.current;
    try {
      const [savedPhotos, info] = await Promise.all([getProgressPhotos(), getProgressPhotoStorageInfo()]);
      if (requestId !== refreshRequestRef.current) return;
      const urls = new Map<string, string>();
      for (const photo of savedPhotos) {
        urls.set(`${photo.id}:thumb`, URL.createObjectURL(photo.thumbnail));
        urls.set(`${photo.id}:full`, URL.createObjectURL(photo.blob));
      }
      const previousUrls = photoUrlsRef.current;
      photoUrlsRef.current = urls;
      setPhotos(savedPhotos);
      setStorageInfo(info);
      setPhotoUrls(urls);
      setStorageError("");
      previousUrls.forEach((url) => URL.revokeObjectURL(url));
    } catch (error) {
      if (requestId !== refreshRequestRef.current) return;
      setStorageError(asErrorMessage(error));
    } finally {
      if (requestId === refreshRequestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const initialRefresh = window.setTimeout(() => void refresh(), 0);
    window.addEventListener(PHOTO_PROGRESS_CHANGE_EVENT, refresh);
    return () => {
      window.clearTimeout(initialRefresh);
      refreshRequestRef.current += 1;
      cameraRequestRef.current += 1;
      mountedRef.current = false;
      window.removeEventListener(PHOTO_PROGRESS_CHANGE_EVENT, refresh);
      photoUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      photoUrlsRef.current.clear();
    };
  }, [refresh]);

  useEffect(() => {
    const video = videoRef.current;
    if (cameraStream && video) {
      video.srcObject = cameraStream;
      void video.play().catch(() => {
        if (mountedRef.current) setStatus("Camera is ready. Tap the video if the preview stays paused.");
      });
    }
    return () => {
      if (video?.srcObject === cameraStream) video.srcObject = null;
      cameraStream?.getTracks().forEach((track) => track.stop());
    };
  }, [cameraStream]);

  const closeCamera = useCallback(() => {
    cameraRequestRef.current += 1;
    cameraStream?.getTracks().forEach((track) => track.stop());
    setCameraStream(null);
    setCountdown(null);
    setCameraStep(0);
    setCameraStarting(false);
  }, [cameraStream]);

  useEffect(() => {
    const stopCameraWhenHidden = () => {
      if (document.visibilityState === "hidden") closeCamera();
    };
    document.addEventListener("visibilitychange", stopCameraWhenHidden);
    return () => document.removeEventListener("visibilitychange", stopCameraWhenHidden);
  }, [closeCamera]);

  useEffect(() => {
    if (!activeDialog) {
      const returnTarget = focusReturnRef.current;
      focusReturnRef.current = null;
      if (returnTarget?.isConnected) returnTarget.focus();
      return;
    }
    dialogActionRef.current?.focus();
  }, [activeDialog]);

  useEffect(() => {
    if (!activeDialog) return;
    const handleDialogKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busy) {
          setPendingDelete(null);
          setPreviewPhoto(null);
        }
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      )].filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      const focusIsOutside = !dialog.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog || focusIsOutside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog || focusIsOutside)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleDialogKeyDown);
    return () => document.removeEventListener("keydown", handleDialogKeyDown);
  }, [activeDialog, busy]);

  const comparePhotos = useMemo(
    () => photos.filter((photo) => photo.view === compareView).sort((left, right) => left.date.localeCompare(right.date) || left.createdAt.localeCompare(right.createdAt)),
    [photos, compareView],
  );
  const filteredPhotos = useMemo(
    () => filterView === "all" ? photos : photos.filter((photo) => photo.view === filterView),
    [photos, filterView],
  );
  const checkInCount = useMemo(() => new Set(photos.map((photo) => photo.date)).size, [photos]);
  const viewCounts = useMemo(() => Object.fromEntries(VIEWS.map((view) => [view, photos.filter((photo) => photo.view === view).length])) as Record<ProgressPhotoView, number>, [photos]);
  const backupPhotoCount = filteredPhotos.filter((photo) =>
    (!backupFromDate || photo.date >= backupFromDate) && (!backupThroughDate || photo.date <= backupThroughDate),
  ).length;
  const invalidBackupDateRange = Boolean(backupFromDate && backupThroughDate && backupFromDate > backupThroughDate);

  const availableIds = new Set(comparePhotos.map((photo) => photo.id));
  const selectedBeforeId = availableIds.has(beforeId) ? beforeId : comparePhotos[0]?.id ?? "";
  const selectedAfterId = availableIds.has(afterId) ? afterId : comparePhotos.at(-1)?.id ?? "";
  const beforePhoto = comparePhotos.find((photo) => photo.id === selectedBeforeId);
  const afterPhoto = comparePhotos.find((photo) => photo.id === selectedAfterId);

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("Camera capture is unavailable in this browser. Add each view from your photos instead.");
      return;
    }
    const requestId = ++cameraRequestRef.current;
    setCameraStarting(true);
    setStatus("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "user" } }, audio: false });
      if (!mountedRef.current || requestId !== cameraRequestRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      setCameraStep(0);
      setCameraStream(stream);
    } catch (error) {
      if (mountedRef.current && requestId === cameraRequestRef.current) {
        setStatus(error instanceof DOMException && error.name === "NotAllowedError"
          ? "Camera access was blocked. Allow camera access or add a photo from your device."
          : "Could not open the camera. Add a photo from your device instead.");
      }
    } finally {
      if (mountedRef.current && requestId === cameraRequestRef.current) setCameraStarting(false);
    }
  }

  const captureCurrentView = useCallback(async () => {
    const video = videoRef.current;
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) {
      setStatus("The camera preview is still starting. Try the countdown again in a moment.");
      setCountdown(null);
      return;
    }
    setBusy(true);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("This browser could not capture the camera frame.");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((result) => result ? resolve(result) : reject(new Error("This browser could not prepare the camera photo.")), "image/jpeg", 0.9);
      });
      await saveProgressPhoto({ blob, date: photoDate, view: VIEWS[cameraStep] });
      setStatus(`${viewLabel(VIEWS[cameraStep])} photo saved for ${displayDate(photoDate)}.`);
      setCountdown(null);
      if (cameraStep === VIEWS.length - 1) closeCamera();
      else setCameraStep((step) => step + 1);
    } catch (error) {
      setStatus(asErrorMessage(error));
      setCountdown(null);
    } finally {
      setBusy(false);
    }
  }, [cameraStep, closeCamera, photoDate]);

  useEffect(() => {
    if (countdown === null || !cameraStream) return;
    if (countdown === 0) {
      const timer = window.setTimeout(() => void captureCurrentView(), 150);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(() => setCountdown((value) => value === null ? null : value - 1), 1_000);
    return () => window.clearTimeout(timer);
  }, [countdown, cameraStream, captureCurrentView]);

  async function addFromFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
      setStatus("Choose a JPEG, PNG, or WebP photo. HEIC files need to be converted by your device first.");
      return;
    }
    if (file.size > 40 * 1024 * 1024) {
      setStatus("Choose an image smaller than 40 MiB.");
      return;
    }
    setBusy(true);
    try {
      await saveProgressPhoto({ blob: file, date: photoDate, view: importView });
      setStatus(`${viewLabel(importView)} photo added for ${displayDate(photoDate)}. The original remains in your gallery.`);
    } catch (error) {
      setStatus(asErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function deletePhoto() {
    if (!pendingDelete) return;
    const photo = pendingDelete;
    setBusy(true);
    try {
      await removePhotoWithCloudChoice(photo, deleteCloudCopy);
      setPendingDelete(null);
        focusReturnRef.current = galleryHeadingRef.current;
      setPreviewPhoto((current) => current?.id === photo.id ? null : current);
      setStatus(deleteCloudCopy ? "Photo removed from this device. Cloud deletion is queued and will finish when connected with backup enabled." : `${viewLabel(photo.view)} photo from ${displayDate(photo.date)} removed from this device. Any cloud backup is kept.`);
    } catch (error) {
      setStatus(asErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function exportBackup() {
    setBusy(true);
    try {
      const backup = await exportProgressPhotos({
        ...(filterView === "all" ? {} : { view: filterView }),
        ...(backupFromDate ? { fromDate: backupFromDate } : {}),
        ...(backupThroughDate ? { throughDate: backupThroughDate } : {}),
      });
      const payload = JSON.stringify(backup);
      const verifiedBackup = parseProgressPhotoBackup(payload);
      if (verifiedBackup.photos.length !== backup.photos.length) throw new Error("Photo backup verification failed. Try the export again.");
      const blob = new Blob([payload], { type: "application/json" });
      if (blob.size > PHOTO_BACKUP_MAX_BYTES) throw new Error("This selection is too large for one photo backup. Choose one view or a shorter date range, then export another file.");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      const selection = filterView === "all" ? "photos" : `${filterView}-photos`;
      link.download = `rolling-ppl-${selection}-${backupFromDate || "all"}-to-${backupThroughDate || "all"}-${todayLocal()}.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setStatus(`Photo backup started with ${verifiedBackup.photos.length} ${verifiedBackup.photos.length === 1 ? "photo" : "photos"}. Keep a copy somewhere outside this browser.`);
    } catch (error) {
      setStatus(asErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function importBackup(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (file.size > PHOTO_BACKUP_MAX_BYTES) {
      setStatus("This photo backup is too large to import at once. Choose smaller files split by view or date range.");
      return;
    }
    setBusy(true);
    try {
      const count = await importProgressPhotos(await file.text());
      setStatus(`${count} photo${count === 1 ? "" : "s"} merged. Existing photos with the same ID were kept; unrelated photos were preserved.`);
    } catch (error) {
      setStatus(asErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function protectStorage() {
    setBusy(true);
    try {
      const granted = await requestProgressPhotoPersistence();
      await refresh();
      setStatus(granted ? "The browser will protect this site's photo storage from automatic cleanup." : "The browser did not grant persistent storage. Export a backup to keep a separate copy.");
    } catch (error) {
      setStatus(asErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function downloadPhoto(photo: ProgressPhoto) {
    const url = URL.createObjectURL(photo.blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `rolling-ppl-${photo.view}-${photo.date}.jpg`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    setStatus(`${viewLabel(photo.view)} photo from ${displayDate(photo.date)} downloaded.`);
  }

  return <section className="photo-progress" aria-label="Progress photos">

    {storageError && <p className="photo-progress-error" role="alert">{storageError}</p>}
    {status && <p className="photo-progress-status" role="status">{status}</p>}

    <details className="photo-backup-accordion"><summary>Photo storage and backups</summary><div><CloudPhotoBackupPanel photos={photos} /></div></details>

    <section className="photo-collection-summary" aria-label="Photo collection summary">
      <div className="photo-collection-total"><strong>{loading ? "Loading your collection…" : `${photos.length} ${photos.length === 1 ? "photo" : "photos"}`}</strong>{!loading && <span>Across {checkInCount} {checkInCount === 1 ? "check-in" : "check-ins"}</span>}</div>
      {!loading && <ul aria-label="Photos by view">{VIEWS.map((view) => <li key={view}><span>{viewLabel(view)}</span><strong>{viewCounts[view]}</strong></li>)}</ul>}
    </section>

    <fieldset className="photo-add-card" disabled={busy || loading}>
      <legend>Add a check-in</legend>
      <p>Use similar lighting and distance each time. Captures are compressed for private storage.</p>
      <div className="photo-add-fields">
        <label>Check-in date<input type="date" value={photoDate} onChange={(event) => setPhotoDate(event.target.value)} required /></label>
        <label>Imported photo view<select value={importView} onChange={(event) => setImportView(event.target.value as ProgressPhotoView)}>{VIEWS.map((view) => <option key={view} value={view}>{viewLabel(view)}</option>)}</select></label>
      </div>
      <div className="photo-add-actions">
        <button type="button" className="primary-action" onClick={() => void startCamera()} disabled={!navigator.mediaDevices?.getUserMedia || cameraStarting || Boolean(cameraStream)}>{cameraStarting ? "Opening camera…" : "Guided camera check-in"}</button>
        <label className="secondary-action photo-file-button">Add from photos<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => void addFromFile(event)} /></label>
      </div>
      <small>Imported photos are copied here. Their original files remain in your phone gallery.</small>
    </fieldset>

    {cameraStream && <div className="photo-camera-card">
      <div className="photo-camera-heading"><div><span>View {cameraStep + 1} of 3</span><h3>{viewLabel(VIEWS[cameraStep])}</h3></div><button className="text-action" type="button" onClick={closeCamera} disabled={busy}>Cancel camera</button></div>
      <p>Keep your whole body inside the guide. The front, side, and back views are captured in order.</p>
      <div className="photo-camera-preview">
        <video ref={videoRef} autoPlay playsInline muted aria-label="Live camera preview for a progress photo" />
        <div className="photo-camera-frame" aria-hidden="true"><i /><i /><i /></div>
        {countdown !== null && <div className="photo-countdown" aria-live="assertive">{countdown > 0 ? countdown : "Hold still"}</div>}
      </div>
      <button type="button" className="primary-action photo-capture-button" onClick={() => { setStatus(""); setCountdown(3); }} disabled={countdown !== null || busy}>{countdown === null ? `Capture ${viewLabel(VIEWS[cameraStep])} in 3 seconds` : "Get ready…"}</button>
    </div>}

    <section className="photo-compare" aria-labelledby="photo-compare-title">
      <div className="photo-section-heading"><div><h3 id="photo-compare-title">Compare check-ins</h3><p>Choose two dates with the same view to compare side by side.</p></div>
        <label>View<select value={compareView} onChange={(event) => setCompareView(event.target.value as ProgressPhotoView)}>{VIEWS.map((view) => <option key={view} value={view}>{viewLabel(view)}</option>)}</select></label>
      </div>
      {comparePhotos.length < 2 ? <p className="photo-empty">Add two {viewLabel(compareView).toLowerCase()} photos to compare them.</p> : <>
        <div className="photo-compare-selectors">
          <label>Earlier photo<select aria-label="Earlier photo" value={selectedBeforeId} onChange={(event) => setBeforeId(event.target.value)}>{comparePhotos.map((photo) => <option key={photo.id} value={photo.id}>{displayDate(photo.date)}</option>)}</select></label>
          <label>Later photo<select aria-label="Later photo" value={selectedAfterId} onChange={(event) => setAfterId(event.target.value)}>{comparePhotos.map((photo) => <option key={photo.id} value={photo.id}>{displayDate(photo.date)}</option>)}</select></label>
        </div>
        <div className="photo-compare-grid">
          {[beforePhoto, afterPhoto].map((photo, index) => <article className="photo-compare-item" key={`${index}-${photo?.id ?? "empty"}`}>
            <h4>{index === 0 ? "Earlier" : "Later"}{photo && <time dateTime={photo.date}>{displayDate(photo.date)}</time>}</h4>
            {photo && <img src={photoUrls.get(`${photo.id}:full`)} alt={`${viewLabel(photo.view)} view, ${displayDate(photo.date)}`} />}
          </article>)}
        </div>
      </>}
    </section>

    <section className="photo-gallery" aria-labelledby="photo-gallery-title">
      <div className="photo-section-heading"><div><h3 id="photo-gallery-title" ref={galleryHeadingRef} tabIndex={-1}>Your check-ins</h3><p>Complete Backup includes device photos; workout exports do not. Each photo shows its backup status.</p></div>
        <label>Show<select value={filterView} onChange={(event) => setFilterView(event.target.value as "all" | ProgressPhotoView)}><option value="all">All views</option>{VIEWS.map((view) => <option key={view} value={view}>{viewLabel(view)}</option>)}</select></label>
      </div>
      <details className="photo-storage-details">
        <summary>Storage and photo backups</summary>
        <div className="photo-storage-content">
          <section aria-labelledby="photo-storage-title">
            <h3 id="photo-storage-title">Storage on this device</h3>
            <p>Device copies stay in this browser. If enabled, photo backup also uploads private copies to your account. Camera captures are not added to your phone gallery.</p>
            <p className="photo-storage-usage">{formatBytes(storageInfo.usage)} of {formatBytes(storageInfo.quota)} site storage used</p>
            {!storageInfo.persisted && <button type="button" className="secondary-action" onClick={() => void protectStorage()} disabled={busy}>Ask browser to protect photos</button>}
            {storageInfo.persisted && <p className="photo-storage-protected">Your browser is protecting this site&apos;s storage from automatic cleanup.</p>}
          </section>
          <section className="photo-backup-tools" aria-labelledby="photo-backup-title">
            <h3 id="photo-backup-title">Move photos to another device</h3>
            <p>Complete Backup includes all photos. For a smaller separate file, export the view shown above and narrow it by date.</p>
            <div className="photo-backup-dates">
              <label>Start date<input type="date" value={backupFromDate} onChange={(event) => setBackupFromDate(event.target.value)} /></label>
              <label>End date<input type="date" value={backupThroughDate} onChange={(event) => setBackupThroughDate(event.target.value)} /></label>
            </div>
            {invalidBackupDateRange && <p className="photo-backup-date-error" role="alert">Start date must be before end date.</p>}
            <div className="photo-backup-actions">
              <button type="button" className="secondary-action" onClick={() => void exportBackup()} disabled={busy || loading || backupPhotoCount === 0 || invalidBackupDateRange}>Export {backupPhotoCount} {backupPhotoCount === 1 ? "photo" : "photos"}</button>
              <label className="secondary-action photo-file-button">Import photo backup<input type="file" accept="application/json,.json" onChange={(event) => void importBackup(event)} /></label>
            </div>
            <p className="photo-backup-note">If a selection is too large for one file, split it by view or choose a shorter date range. You can also download a single photo from its preview.</p>
          </section>
        </div>
      </details>
      {loading ? <p className="photo-empty">Loading private photos…</p> : filteredPhotos.length === 0 ? <p className="photo-empty">No {filterView === "all" ? "photos" : `${filterView} photos`} saved yet.</p> : <div className="photo-grid">
        {filteredPhotos.map((photo) => <article className="photo-card" key={photo.id}>
          <button className="photo-thumbnail-button" type="button" onClick={(event) => { focusReturnRef.current = event.currentTarget; setPreviewPhoto(photo); }} aria-label={`Open ${viewLabel(photo.view)} photo from ${displayDate(photo.date)}`}>
            <img src={photoUrls.get(`${photo.id}:thumb`)} alt="" loading="lazy" />
          </button>
          <div className="photo-card-details"><div><strong>{displayDate(photo.date)}</strong><span>{viewLabel(photo.view)} view</span><span className="photo-cloud-status">{cloudPhotoStatus(photo, cloudBackup)}</span></div><button type="button" className="text-action" onClick={(event) => { focusReturnRef.current = event.currentTarget; setDeleteCloudCopy(false); setPendingDelete(photo); }} disabled={busy}>Delete</button></div>
        </article>)}
      </div>}
    </section>

    {pendingDelete && <div className="photo-dialog-backdrop"><section ref={dialogRef} tabIndex={-1} className="photo-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="photo-delete-title" aria-describedby="photo-delete-description">
      <h3 id="photo-delete-title">Remove this photo?</h3><p id="photo-delete-description">The {viewLabel(pendingDelete.view).toLowerCase()} photo from {displayDate(pendingDelete.date)} will be removed from this device. Any original in your gallery stays there. Your cloud copy is kept unless you choose to delete it below.</p>
      {pendingDelete.cloud && pendingDelete.cloud.status !== "deleted" && pendingDelete.cloud.owner === cloudBackup.owner && <label className="photo-cloud-delete-choice"><input type="checkbox" checked={deleteCloudCopy} onChange={(event) => setDeleteCloudCopy(event.target.checked)} disabled={busy} />Also delete its cloud backup. It cannot be recovered from your account afterward; other devices may still keep local copies.</label>}
      {pendingDelete.cloud && pendingDelete.cloud.owner !== cloudBackup.owner && <p>To delete this photo&apos;s cloud backup, sign in to the account that owns it.</p>}
      <div><button ref={dialogActionRef} type="button" className="text-action" onClick={() => setPendingDelete(null)} disabled={busy}>Keep photo</button><button type="button" className="danger-action" onClick={() => void deletePhoto()} disabled={busy}>Delete photo</button></div>
    </section></div>}

    {previewPhoto && <div className="photo-dialog-backdrop"><section ref={dialogRef} tabIndex={-1} className="photo-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="photo-preview-title">
      <div><h3 id="photo-preview-title">{viewLabel(previewPhoto.view)} · {displayDate(previewPhoto.date)}</h3><div className="photo-preview-actions"><button type="button" className="secondary-action" onClick={() => downloadPhoto(previewPhoto)}>Download photo</button><button ref={dialogActionRef} type="button" className="text-action" onClick={() => setPreviewPhoto(null)}>Close</button></div></div>
      <img src={photoUrls.get(`${previewPhoto.id}:full`)} alt={`${viewLabel(previewPhoto.view)} view, ${displayDate(previewPhoto.date)}`} />
    </section></div>}
  </section>;
}

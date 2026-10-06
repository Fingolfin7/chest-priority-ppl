import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  exportProgressPhotos,
  getProgressPhotoStorageInfo,
  getProgressPhotos,
  importProgressPhotos,
  PHOTO_BACKUP_MAX_BYTES,
  PHOTO_PROGRESS_CHANGE_EVENT,
  requestProgressPhotoPersistence,
  saveProgressPhoto,
  type ProgressPhoto,
  type ProgressPhotoView,
} from "./photoStorage";
import "./photoProgress.css";
import { CloudPhotoBackupPanel, useCloudPhotoBackup } from "./CloudPhotoBackupPanel";
import { cloudPhotoStatus, removePhotoWithCloudChoice } from "./cloudPhotoBackup";
import { nextScheduledCheckIn } from "./photoCheckInModel";
import { usePhotoCheckInPreferences } from "./usePhotoCheckIns";

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

function samePhotoImage(left: ProgressPhoto, right: ProgressPhoto) {
  return left.createdAt === right.createdAt && left.blob.size === right.blob.size && left.thumbnail.size === right.thumbnail.size;
}

// Object URLs exist only while an image is mounted, so full-size copies are created on demand.
function BlobImage({ blob, alt, loading }: { blob: Blob; alt: string; loading?: "lazy" }) {
  const imageRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const image = imageRef.current;
    if (!image) return;
    const url = URL.createObjectURL(blob);
    image.src = url;
    return () => {
      image.removeAttribute("src");
      URL.revokeObjectURL(url);
    };
  }, [blob]);
  return <img ref={imageRef} alt={alt} loading={loading} />;
}

export function PhotoProgress() {
  const cloudBackup = useCloudPhotoBackup();
  const [checkIns, setCheckIns] = usePhotoCheckInPreferences();
  const [photos, setPhotos] = useState<ProgressPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [storageError, setStorageError] = useState("");
  const [status, setStatus] = useState("");
  const [photoDate, setPhotoDate] = useState(todayLocal);
  const [importView, setImportView] = useState<ProgressPhotoView>("front");
  const [filterView, setFilterView] = useState<"all" | ProgressPhotoView>("all");
  const [backupView, setBackupView] = useState<"all" | ProgressPhotoView>("all");
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
  const [busy, setBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraRequestRef = useRef(0);
  const mountedRef = useRef(false);
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
      // Reuse blobs of unchanged photos so cloud status updates don't recreate image URLs.
      setPhotos((current) => {
        const previous = new Map(current.map((photo) => [photo.id, photo]));
        return savedPhotos.map((photo) => {
          const prior = previous.get(photo.id);
          return prior && samePhotoImage(prior, photo) ? { ...photo, blob: prior.blob, thumbnail: prior.thumbnail } : photo;
        });
      });
      setStorageInfo(info);
      setStorageError("");
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
  const nextCheckIn = nextScheduledCheckIn(photos.map((photo) => photo.date), checkIns);
  const viewCounts = useMemo(() => Object.fromEntries(VIEWS.map((view) => [view, photos.filter((photo) => photo.view === view).length])) as Record<ProgressPhotoView, number>, [photos]);
  const canCompare = VIEWS.some((view) => viewCounts[view] >= 2);
  const backupPhotoCount = photos.filter((photo) =>
    (backupView === "all" || photo.view === backupView) && (!backupFromDate || photo.date >= backupFromDate) && (!backupThroughDate || photo.date <= backupThroughDate),
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
      setStatus(`${viewLabel(importView)} photo added for ${displayDate(photoDate)}.`);
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
        ...(backupView === "all" ? {} : { view: backupView }),
        ...(backupFromDate ? { fromDate: backupFromDate } : {}),
        ...(backupThroughDate ? { throughDate: backupThroughDate } : {}),
      });
      const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });
      if (blob.size > PHOTO_BACKUP_MAX_BYTES) throw new Error("This selection is too large for one photo backup. Choose one view or a shorter date range, then export another file.");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      const selection = backupView === "all" ? "photos" : `${backupView}-photos`;
      link.download = `rolling-ppl-${selection}-${backupFromDate || "all"}-to-${backupThroughDate || "all"}-${todayLocal()}.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setStatus(`Exported ${backup.photos.length} ${backup.photos.length === 1 ? "photo" : "photos"}. Keep the file somewhere outside this browser.`);
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
      setStatus(`${count} photo${count === 1 ? "" : "s"} merged. Photos already on this device were kept.`);
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
      setStatus(granted ? "The browser will protect photo storage from automatic cleanup." : "The browser declined. Turn on cloud backup or export a copy.");
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

    {(loading || photos.length > 0) && <section className="photo-collection-summary" aria-label="Photo collection summary">
      <div className="photo-collection-total"><strong>{loading ? "Loading your collection…" : `${photos.length} ${photos.length === 1 ? "photo" : "photos"}`}</strong>{!loading && <span>Across {checkInCount} {checkInCount === 1 ? "check-in" : "check-ins"}</span>}</div>
      {!loading && <ul aria-label="Photos by view">{VIEWS.map((view) => <li key={view}><span>{viewLabel(view)}</span><strong>{viewCounts[view]}</strong></li>)}</ul>}
    </section>}

    <fieldset className="photo-add-card" disabled={busy || loading}>
      <legend>Add a check-in</legend>
      <p>Use similar lighting and distance each time.</p>
      <div className="photo-add-fields">
        <label>Check-in date<input type="date" value={photoDate} onChange={(event) => setPhotoDate(event.target.value)} required /></label>
        <label>Imported photo view<select value={importView} onChange={(event) => setImportView(event.target.value as ProgressPhotoView)}>{VIEWS.map((view) => <option key={view} value={view}>{viewLabel(view)}</option>)}</select></label>
      </div>
      <div className="photo-add-actions">
        <button type="button" className="primary-action" onClick={() => void startCamera()} disabled={!navigator.mediaDevices?.getUserMedia || cameraStarting || Boolean(cameraStream)}>{cameraStarting ? "Opening camera…" : "Guided camera check-in"}</button>
        <label className="secondary-action photo-file-button">Add from photos<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => void addFromFile(event)} /></label>
      </div>
      <small>Imports are copied here; originals stay in your gallery. Camera captures are not added to your gallery.</small>
      <div className="photo-check-in-schedule">
        <label>Check-in reminders<select value={checkIns.intervalDays} onChange={(event) => setCheckIns({ ...checkIns, intervalDays: Number(event.target.value) })}><option value={7}>Every week</option><option value={14}>Every 2 weeks</option><option value={21}>Every 3 weeks</option><option value={28}>Every 4 weeks</option><option value={0}>Off</option></select></label>
        <small>{!checkIns.intervalDays ? "Body won't remind you about photos." : nextCheckIn ? `Next check-in due ${displayDate(nextCheckIn)}. Sustained weight milestones add one, too.` : "Reminders start after your first photos. Sustained weight milestones add a check-in, too."}</small>
      </div>
    </fieldset>

    {cameraStream && <div className="photo-camera-card">
      <div className="photo-camera-heading"><div><span>View {cameraStep + 1} of 3</span><h3>{viewLabel(VIEWS[cameraStep])}</h3></div><button className="text-action" type="button" onClick={closeCamera} disabled={busy}>Cancel camera</button></div>
      <p>Keep your whole body inside the guide. Front, side, and back are captured in order.</p>
      <div className="photo-camera-preview">
        <video ref={videoRef} autoPlay playsInline muted aria-label="Live camera preview for a progress photo" />
        <div className="photo-camera-frame" aria-hidden="true"><i /><i /><i /></div>
        {countdown !== null && <div className="photo-countdown" aria-live="assertive">{countdown > 0 ? countdown : "Hold still"}</div>}
      </div>
      <button type="button" className="primary-action photo-capture-button" onClick={() => { setStatus(""); setCountdown(3); }} disabled={countdown !== null || busy}>{countdown === null ? `Capture ${viewLabel(VIEWS[cameraStep])} in 3 seconds` : "Get ready…"}</button>
    </div>}

    {canCompare && <section className="photo-compare" aria-labelledby="photo-compare-title">
      <div className="photo-section-heading"><div><h3 id="photo-compare-title">Compare check-ins</h3></div>
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
            {photo && <BlobImage blob={photo.blob} alt={`${viewLabel(photo.view)} view, ${displayDate(photo.date)}`} />}
          </article>)}
        </div>
      </>}
    </section>}

    <section className="photo-gallery" aria-labelledby="photo-gallery-title">
      <div className="photo-section-heading"><div><h3 id="photo-gallery-title" ref={galleryHeadingRef} tabIndex={-1}>Your check-ins</h3></div>
        <label>Show<select value={filterView} onChange={(event) => setFilterView(event.target.value as "all" | ProgressPhotoView)}><option value="all">All views</option>{VIEWS.map((view) => <option key={view} value={view}>{viewLabel(view)}</option>)}</select></label>
      </div>
      {loading ? <p className="photo-empty">Loading private photos…</p> : filteredPhotos.length === 0 ? <p className="photo-empty">No {filterView === "all" ? "photos" : `${filterView} photos`} saved yet.</p> : <div className="photo-grid">
        {filteredPhotos.map((photo) => <article className="photo-card" key={photo.id}>
          <button className="photo-thumbnail-button" type="button" onClick={(event) => { focusReturnRef.current = event.currentTarget; setPreviewPhoto(photo); }} aria-label={`Open ${viewLabel(photo.view)} photo from ${displayDate(photo.date)}`}>
            <BlobImage blob={photo.thumbnail} alt="" loading="lazy" />
          </button>
          <div className="photo-card-details"><div><strong>{displayDate(photo.date)}</strong><span>{viewLabel(photo.view)} view</span><span className="photo-cloud-status">{cloudPhotoStatus(photo, cloudBackup)}</span></div><button type="button" className="text-action" onClick={(event) => { focusReturnRef.current = event.currentTarget; setDeleteCloudCopy(false); setPendingDelete(photo); }} disabled={busy}>Delete</button></div>
        </article>)}
      </div>}
    </section>

    <details className="photo-backup-accordion photo-storage-details">
      <summary>Storage and backups</summary>
      <div className="photo-storage-content">
        <section aria-labelledby="photo-storage-title">
          <h3 id="photo-storage-title">On this device</h3>
          <p>Photos live in this browser. Clearing site data deletes any that are not backed up.</p>
          <p className="photo-storage-usage">{formatBytes(storageInfo.usage)} of {formatBytes(storageInfo.quota)} site storage used</p>
          {storageInfo.persisted ? <p className="photo-storage-protected">Protected from automatic browser cleanup.</p> : <button type="button" className="secondary-action" onClick={() => void protectStorage()} disabled={busy}>Ask browser to protect photos</button>}
        </section>
        <CloudPhotoBackupPanel photos={photos} />
        <section className="photo-backup-tools" aria-labelledby="photo-backup-title">
          <h3 id="photo-backup-title">Export or import photo files</h3>
          <p>Complete Backup includes all photos; workout exports do not. Export a smaller file here, split by view or date if it is too large.</p>
          <div className="photo-backup-dates">
            <label className="photo-backup-view">View<select value={backupView} onChange={(event) => setBackupView(event.target.value as "all" | ProgressPhotoView)}><option value="all">All views</option>{VIEWS.map((view) => <option key={view} value={view}>{viewLabel(view)}</option>)}</select></label>
            <label>Start date<input type="date" value={backupFromDate} onChange={(event) => setBackupFromDate(event.target.value)} /></label>
            <label>End date<input type="date" value={backupThroughDate} onChange={(event) => setBackupThroughDate(event.target.value)} /></label>
          </div>
          {invalidBackupDateRange && <p className="photo-backup-date-error" role="alert">Start date must be before end date.</p>}
          <div className="photo-backup-actions">
            <button type="button" className="secondary-action" onClick={() => void exportBackup()} disabled={busy || loading || backupPhotoCount === 0 || invalidBackupDateRange}>Export {backupPhotoCount} {backupPhotoCount === 1 ? "photo" : "photos"}</button>
            <label className="secondary-action photo-file-button">Import photo file<input type="file" accept="application/json,.json" onChange={(event) => void importBackup(event)} /></label>
          </div>
          <p className="photo-backup-note">To save a single photo, open it and choose Download.</p>
        </section>
      </div>
    </details>

    {pendingDelete && <div className="photo-dialog-backdrop"><section ref={dialogRef} tabIndex={-1} className="photo-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="photo-delete-title" aria-describedby="photo-delete-description">
      <h3 id="photo-delete-title">Remove this photo?</h3><p id="photo-delete-description">The {viewLabel(pendingDelete.view).toLowerCase()} photo from {displayDate(pendingDelete.date)} will be removed from this device. Any original in your gallery stays there. Your cloud copy is kept unless you choose to delete it below.</p>
      {pendingDelete.cloud && pendingDelete.cloud.status !== "deleted" && pendingDelete.cloud.owner === cloudBackup.owner && <label className="photo-cloud-delete-choice"><input type="checkbox" checked={deleteCloudCopy} onChange={(event) => setDeleteCloudCopy(event.target.checked)} disabled={busy} />Also delete its cloud backup. It cannot be recovered from your account afterward; other devices may still keep local copies.</label>}
      {pendingDelete.cloud && pendingDelete.cloud.owner !== cloudBackup.owner && <p>To delete this photo&apos;s cloud backup, sign in to the account that owns it.</p>}
      <div><button ref={dialogActionRef} type="button" className="text-action" onClick={() => setPendingDelete(null)} disabled={busy}>Keep photo</button><button type="button" className="danger-action" onClick={() => void deletePhoto()} disabled={busy}>Delete photo</button></div>
    </section></div>}

    {previewPhoto && <div className="photo-dialog-backdrop"><section ref={dialogRef} tabIndex={-1} className="photo-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="photo-preview-title">
      <div><h3 id="photo-preview-title">{viewLabel(previewPhoto.view)} · {displayDate(previewPhoto.date)}</h3><div className="photo-preview-actions"><button type="button" className="secondary-action" onClick={() => downloadPhoto(previewPhoto)}>Download photo</button><button ref={dialogActionRef} type="button" className="text-action" onClick={() => setPreviewPhoto(null)}>Close</button></div></div>
      <BlobImage blob={previewPhoto.blob} alt={`${viewLabel(previewPhoto.view)} view, ${displayDate(previewPhoto.date)}`} />
    </section></div>}
  </section>;
}

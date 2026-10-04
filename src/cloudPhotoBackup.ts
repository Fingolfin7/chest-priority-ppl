import {
  configurePhotoCloudOwner, deleteProgressPhoto, getProgressPhotos, PHOTO_PROGRESS_CHANGE_EVENT,
  restoreCloudProgressPhoto, updateProgressPhotoCloud, type ProgressPhoto,
} from "./photoStorage.ts";
import {
  clearCloudPhotoSession, cloudPhotoFetch, CLOUD_PHOTO_SESSION_KEY, completeCloudPhotoSignIn, parseCloudPhotoConfig,
  readCloudPhotoSession, refreshCloudPhotoSession, signInCloudPhotos, signOutCloudPhotos, storeCloudPhotoSession,
  type CloudPhotoConfig, type CloudPhotoSession,
} from "./cloudPhotoAuth.ts";

type CloudMetadata = { id: string; date: string; view: ProgressPhoto["view"]; mimeType: ProgressPhoto["mimeType"]; size: number; checksumSha256: string; width: number; height: number; createdAt: string };
type CloudManifest = { photos: CloudMetadata[]; tombstones: { id: string; deletedAt: string }[]; nextCursor?: string };
type Preferences = { enabled: string[]; removed: Record<string, string[]>; deletions: Record<string, string[]> };
const PREFERENCES_KEY = "rolling-ppl:cloud-photo-preferences";
export type CloudPhotoBackupState = { ready: boolean; available: boolean; enabled: boolean; signedIn: boolean; owner?: string; email?: string; syncing: boolean; error: string; cloudCount: number; recoverableCount: number; deletionCount: number };
let snapshot: CloudPhotoBackupState = { ready: false, available: false, enabled: false, signedIn: false, syncing: false, error: "", cloudCount: 0, recoverableCount: 0, deletionCount: 0 };
let config: CloudPhotoConfig | undefined;
let session: CloudPhotoSession | undefined;
let initialized: Promise<void> | undefined;
let generation = 0;
let syncTimer: ReturnType<typeof setTimeout> | undefined;
let manifest: CloudManifest = { photos: [], tombstones: [] };
const subscribers = new Set<() => void>();
export const subscribeCloudPhotoBackup = (listener: () => void) => { subscribers.add(listener); return () => { subscribers.delete(listener); }; };
export const getCloudPhotoBackupState = () => snapshot;
function publish(update: Partial<CloudPhotoBackupState>) { snapshot = { ...snapshot, ...update }; subscribers.forEach((listener) => listener()); }
function preferences(): Preferences {
  try {
    const parsed = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? "null") as Preferences | null;
    if (parsed && Array.isArray(parsed.enabled) && parsed.removed && parsed.deletions) return parsed;
  } catch { /* Fresh preferences do not discard any photos. */ }
  return { enabled: [], removed: {}, deletions: {} };
}
function writePreferences(value: Preferences) { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(value)); }
function activeOwner() { return session && snapshot.enabled ? session.owner : undefined; }
function applySession(value?: CloudPhotoSession) {
  generation += 1;
  session = value;
  manifest = { photos: [], tombstones: [] };
  publish({ signedIn: Boolean(value), owner: value?.owner, email: value?.email, enabled: Boolean(value && preferences().enabled.includes(value.owner)), syncing: false, cloudCount: 0, recoverableCount: 0, deletionCount: value ? (preferences().deletions[value.owner] ?? []).length : 0 });
}
function scheduleSync() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncTimer = undefined; void syncCloudPhotos(); }, 400);
}
function errorMessage(error: unknown) {
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) return "Photo backup took too long to connect. Your local photos are safe; retry when your connection improves.";
  return error instanceof Error ? error.message : "Photo backup could not connect. Your local photos are safe.";
}

export function initializeCloudPhotoBackup(): Promise<void> {
  if (initialized) return initialized;
  configurePhotoCloudOwner(activeOwner);
  initialized = (async () => {
    window.addEventListener("online", scheduleSync);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && snapshot.enabled && snapshot.signedIn) scheduleSync();
    });
    window.addEventListener(PHOTO_PROGRESS_CHANGE_EVENT, () => { if (!snapshot.syncing) scheduleSync(); });
    window.addEventListener("storage", (event) => {
      if (event.key === CLOUD_PHOTO_SESSION_KEY || event.key === PREFERENCES_KEY) { applySession(readCloudPhotoSession()); scheduleSync(); }
    });
    try {
      const response = await cloudPhotoFetch(`${import.meta.env?.BASE_URL ?? "/"}cloud-photo-config.json`, { cache: "no-store" });
      if (!response.ok) { publish({ ready: true, available: false }); return; }
      // Vite and static hosts may serve their HTML fallback for a missing JSON
      // file. Treat this as unavailable rather than exposing a parser error.
      const publicConfig: unknown = await response.json().catch(() => undefined);
      if (!publicConfig) { publish({ ready: true, available: false }); return; }
      config = parseCloudPhotoConfig(publicConfig);
      const value = await completeCloudPhotoSignIn(config);
      applySession(value);
      if (value && sessionStorage.getItem("rolling-ppl:enable-photo-backup") === "yes") {
        sessionStorage.removeItem("rolling-ppl:enable-photo-backup");
        const prefs = preferences();
        if (!prefs.enabled.includes(value.owner)) prefs.enabled.push(value.owner);
        writePreferences(prefs);
        publish({ enabled: true });
      }
      publish({ ready: true, available: true });
      await syncCloudPhotos();
    } catch (error) { publish({ ready: true, available: Boolean(config), error: errorMessage(error) }); }
  })();
  return initialized;
}

export async function enableCloudPhotoBackup() {
  await initializeCloudPhotoBackup();
  if (!config) return;
  publish({ error: "" });
  try {
    if (!session) {
      sessionStorage.setItem("rolling-ppl:enable-photo-backup", "yes");
      await signInCloudPhotos(config);
      return;
    }
    const prefs = preferences();
    if (!prefs.enabled.includes(session.owner)) prefs.enabled.push(session.owner);
    writePreferences(prefs);
    publish({ enabled: true });
    await syncCloudPhotos();
  } catch (error) { publish({ error: errorMessage(error) }); }
}
export function pauseCloudPhotoBackup() {
  if (!session) return;
  const prefs = preferences();
  prefs.enabled = prefs.enabled.filter((owner) => owner !== session?.owner);
  writePreferences(prefs);
  generation += 1;
  publish({ enabled: false, syncing: false });
}
export async function disconnectCloudPhotoBackup() {
  const currentConfig = config;
  const currentSession = session;
  applySession();
  clearCloudPhotoSession();
  if (currentConfig) await signOutCloudPhotos(currentConfig, currentSession);
}

// Records backup shares this account session. These helpers keep a single
// owner of the session and its refreshes.
export async function signInForCloudBackup(flag: string) {
  await initializeCloudPhotoBackup();
  if (!config) return;
  sessionStorage.setItem(flag, "yes");
  await signInCloudPhotos(config);
}
export async function cloudBackupAccess() {
  await initializeCloudPhotoBackup();
  if (!config || !session) throw new Error("Sign in to use cloud backup.");
  const owner = session.owner;
  const refreshed = await refreshCloudPhotoSession(config, session);
  if (session?.owner !== owner) throw new Error("The cloud backup account changed. Try again.");
  session = refreshed;
  storeCloudPhotoSession(refreshed);
  return { owner, token: refreshed.accessToken, apiBaseUrl: config.apiBaseUrl };
}

export async function signInAgainCloudPhotoBackup() {
  if (!config) return;
  sessionStorage.setItem("rolling-ppl:enable-photo-backup", "yes");
  await signInCloudPhotos(config).catch((error: unknown) => publish({ error: errorMessage(error) }));
}

class CloudPhotoApiError extends Error {
  code?: string;
  constructor(message: string, code?: string) { super(message); this.code = code; }
}
async function request<T>(path: string, token: string, method = "GET", body?: unknown): Promise<T> {
  const response = await cloudPhotoFetch(`${config!.apiBaseUrl}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) {
    const failure = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
    throw new CloudPhotoApiError(response.status === 401 ? "Sign in again to continue photo backup." : failure.error?.message ?? "Photo backup could not connect. Your local photos are safe.", failure.error?.code);
  }
  return response.json() as Promise<T>;
}
export async function photoChecksum(blob: Blob) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  return btoa(String.fromCharCode(...hash));
}
export function cloudPhotoStatus(photo: ProgressPhoto, state = snapshot): string {
  if (!photo.cloud) return "Saved on device";
  if (photo.cloud.owner !== state.owner) return "Saved on device · another account";
  if (photo.cloud.status === "deleted") return "Saved on device · cloud copy deleted";
  if (photo.cloud.status === "backed-up") return "Backed up";
  return state.enabled && state.signedIn ? "Saved on device · backup pending" : "Saved on device · backup paused";
}

export async function syncCloudPhotos() {
  if (!config || !session || !snapshot.enabled || snapshot.syncing || navigator.onLine === false) return;
  const run = generation;
  const owner = session.owner;
  const assertCurrent = () => { if (run !== generation || session?.owner !== owner || !snapshot.enabled) throw new Error("Photo backup account changed. Local photos were kept."); };
  publish({ syncing: true, error: "" });
  try {
    const refreshed = await refreshCloudPhotoSession(config, session);
    assertCurrent();
    session = refreshed;
    storeCloudPhotoSession(refreshed);
    const token = refreshed.accessToken;
    const prefs = preferences();
    for (const id of prefs.deletions[owner] ?? []) {
      assertCurrent();
      await request(`/photos/${encodeURIComponent(id)}`, token, "DELETE");
      assertCurrent();
      const latest = preferences();
      latest.deletions[owner] = (latest.deletions[owner] ?? []).filter((value) => value !== id);
      writePreferences(latest);
    }
    const complete: CloudManifest = { photos: [], tombstones: [] };
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      assertCurrent();
      const page = await request<CloudManifest>(`/photos${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, token);
      if (!Array.isArray(page.photos) || !Array.isArray(page.tombstones)) throw new Error("Photo backup returned an invalid collection. Your local photos were kept.");
      complete.photos.push(...page.photos);
      complete.tombstones.push(...page.tombstones);
      cursor = page.nextCursor;
      if (cursor && seenCursors.has(cursor)) throw new Error("Photo backup could not finish reading the collection. Try again.");
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    assertCurrent();
    manifest = complete;
    const deleted = new Set(complete.tombstones.map((entry) => entry.id));
    const records = await getProgressPhotos();
    const remote = new Map(complete.photos.map((photo) => [photo.id, photo]));
    for (const photo of records) {
      assertCurrent();
      if (photo.cloud?.owner !== owner) continue;
      if (deleted.has(photo.id)) {
        if (photo.cloud.status !== "deleted") await updateProgressPhotoCloud(photo.id, { owner, status: "deleted" });
        continue;
      }
      if (photo.cloud.status === "deleted" || (preferences().deletions[owner] ?? []).includes(photo.id)) continue;
      const remotePhoto = remote.get(photo.id);
      // Originals are immutable after save. A previously confirmed local
      // checksum plus matching cloud metadata lets routine foreground checks
      // avoid reading and hashing every original again.
      if (photo.cloud.status === "backed-up" && photo.cloud.checksumSha256
        && remotePhoto?.checksumSha256 === photo.cloud.checksumSha256
        && remotePhoto.size === photo.blob.size && remotePhoto.mimeType === photo.mimeType) continue;
      const checksumSha256 = await photoChecksum(photo.blob);
      assertCurrent();
      if (remote.get(photo.id)?.checksumSha256 === checksumSha256) {
        if (photo.cloud.status !== "backed-up" || photo.cloud.checksumSha256 !== checksumSha256) await updateProgressPhotoCloud(photo.id, { owner, status: "backed-up", checksumSha256 });
        continue;
      }
      if (photo.cloud.status !== "pending") await updateProgressPhotoCloud(photo.id, { owner, status: "pending" });
      const metadata = { date: photo.date, view: photo.view, mimeType: photo.mimeType, size: photo.blob.size, checksumSha256, width: photo.width, height: photo.height, createdAt: photo.createdAt };
      try {
        const upload = await request<{ uploadId: string; url: string; fields: Record<string, string>; alreadyUploaded?: boolean; photo?: CloudMetadata }>(`/photos/${encodeURIComponent(photo.id)}/upload`, token, "POST", metadata);
        assertCurrent();
        let confirmed = upload.photo;
        if (!upload.alreadyUploaded) {
          const form = new FormData();
          for (const [key, value] of Object.entries(upload.fields)) form.append(key, value);
          form.append("file", photo.blob, `${photo.id}.jpg`);
          const uploaded = await cloudPhotoFetch(upload.url, { method: "POST", body: form }, 90_000);
          if (!uploaded.ok) throw new Error("This photo could not upload. It is saved on this device and will retry when you reopen the app or reconnect.");
          assertCurrent();
          confirmed = (await request<{ photo: CloudMetadata }>(`/photos/${encodeURIComponent(photo.id)}/confirm`, token, "POST", { uploadId: upload.uploadId })).photo;
        }
        assertCurrent();
        if (!confirmed || confirmed.checksumSha256 !== checksumSha256) throw new Error("Photo backup could not verify this photo. The local original is safe.");
        await updateProgressPhotoCloud(photo.id, { owner, status: "backed-up", checksumSha256 });
        remote.set(photo.id, confirmed);
      } catch (error) {
        if (error instanceof CloudPhotoApiError && error.code === "PHOTO_DELETED") {
          await updateProgressPhotoCloud(photo.id, { owner, status: "deleted" });
        } else throw error;
      }
    }
    assertCurrent();
    manifest.photos = [...remote.values()];
    const localIds = new Set(records.map((photo) => photo.id));
    publish({ cloudCount: manifest.photos.length, recoverableCount: manifest.photos.filter((photo) => !localIds.has(photo.id)).length, deletionCount: (preferences().deletions[owner] ?? []).length });
  } catch (error) {
    if (run === generation) publish({ error: errorMessage(error) });
  } finally {
    if (run === generation) {
      publish({ syncing: false });
      // A capture/import may have finished while the worker was busy.
      if (!snapshot.error && snapshot.enabled) {
        const pending = (await getProgressPhotos().catch(() => [])).some((photo) => photo.cloud?.owner === owner && photo.cloud.status === "pending");
        if (pending || (preferences().deletions[owner] ?? []).length > 0) scheduleSync();
      }
    }
  }
}

export async function associateExistingCloudPhotos() {
  const owner = activeOwner();
  if (!owner || snapshot.syncing) return;
  try {
    for (const photo of await getProgressPhotos()) {
      if (activeOwner() !== owner) return;
      if (!photo.cloud) await updateProgressPhotoCloud(photo.id, { owner, status: "pending" });
    }
    await syncCloudPhotos();
  } catch (error) { publish({ error: errorMessage(error) }); }
}

export async function recoverCloudPhotos() {
  if (!config || !session || !snapshot.enabled || snapshot.syncing) return;
  const run = generation;
  const owner = session.owner;
  publish({ syncing: true, error: "" });
  try {
    const refreshed = await refreshCloudPhotoSession(config, session);
    if (run !== generation) return;
    session = refreshed;
    storeCloudPhotoSession(refreshed);
    const existing = new Set((await getProgressPhotos()).map((photo) => photo.id));
    for (const photo of manifest.photos) {
      if (run !== generation) return;
      if (existing.has(photo.id)) continue;
      const download = await request<{ url: string; photo: CloudMetadata }>(`/photos/${encodeURIComponent(photo.id)}/download`, refreshed.accessToken);
      if (run !== generation) return;
      const response = await cloudPhotoFetch(download.url, {}, 90_000);
      if (!response.ok) throw new Error("Could not recover a photo. Your cloud backup is still safe; try again.");
      const blob = await response.blob();
      if (blob.size !== photo.size || await photoChecksum(blob) !== photo.checksumSha256) throw new Error("The recovered photo could not be verified. Try recovering it again.");
      if (run !== generation) return;
      await restoreCloudProgressPhoto({ id: photo.id, date: photo.date, view: photo.view, mimeType: photo.mimeType, blob, createdAt: photo.createdAt, cloud: { owner, status: "backed-up", checksumSha256: photo.checksumSha256 } });
    }
    publish({ recoverableCount: 0 });
  } catch (error) { if (run === generation) publish({ error: errorMessage(error) }); }
  finally { if (run === generation) publish({ syncing: false }); }
}

/** Local removal never means cloud deletion. Explicit cloud removal is queued durably. */
export async function removePhotoWithCloudChoice(photo: ProgressPhoto, alsoDeleteBackup: boolean) {
  if (alsoDeleteBackup && (!session || photo.cloud?.owner !== session.owner)) throw new Error("Sign in to the account that owns this photo to delete its cloud backup.");
  if (photo.cloud) {
    const prefs = preferences();
    const owner = photo.cloud.owner;
    prefs.removed[owner] = [...new Set([...(prefs.removed[owner] ?? []), photo.id])];
    if (alsoDeleteBackup) prefs.deletions[owner] = [...new Set([...(prefs.deletions[owner] ?? []), photo.id])];
    writePreferences(prefs);
  }
  await deleteProgressPhoto(photo.id);
  if (alsoDeleteBackup) {
    publish({ deletionCount: session ? (preferences().deletions[session.owner] ?? []).length : 0 });
    scheduleSync();
  }
}

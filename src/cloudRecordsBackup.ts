import type { PeerSyncManager } from "./peerSyncManager";
import { createCompleteBackup, parseCompleteBackup, restoreCompleteBackup, type CompleteBackup, type ReadyBackup } from "./completeBackup";
import { cloudBackupAccess, getCloudPhotoBackupState, initializeCloudPhotoBackup, signInForCloudBackup, subscribeCloudPhotoBackup } from "./cloudPhotoBackup";
import { cloudPhotoFetch } from "./cloudPhotoAuth";
import { BODY_PROGRESS_EVENT } from "./bodyProgressModel";
import { FORECAST_HISTORY_CHANGE_EVENT } from "./forecastHistory";

// Automatic cloud copies of everything except photos, using the photo backup
// account. Each browser uploads only its own copy (keyed by a random ID kept
// in this browser), so a cleared or half-synced browser never replaces another
// browser's backup. Restoring merges like a downloaded complete backup.
export type CloudRecordsSummary = { savedAt: string; size: number; workouts: number; foodDays: number; weighIns: number };
export type CloudRecordsCopy = { date: string; size: number; savedAt: string };
export type CloudRecordsDevice = CloudRecordsSummary & { device: string; name: string; copies: CloudRecordsCopy[] };
export type CloudRecordsState = { device: string; enabled: boolean; busy: boolean; error: string; status: string; last?: CloudRecordsSummary };

type Preferences = { device: string; enabled: string[]; last: Record<string, CloudRecordsSummary & { hash: string }> };
const PREFERENCES_KEY = "rolling-ppl:cloud-records-backup";
const ENABLE_FLAG = "rolling-ppl:enable-records-backup";
const UPLOAD_DELAY = 30_000;

let manager: PeerSyncManager | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let due = 0;
let running: Promise<void> | undefined;
let again = false;
let activity = { busy: false, error: "", status: "" };
let snapshot: CloudRecordsState = { device: "", enabled: false, busy: false, error: "", status: "" };
const subscribers = new Set<() => void>();
export const subscribeCloudRecordsBackup = (listener: () => void) => { subscribers.add(listener); return () => { subscribers.delete(listener); }; };
export const getCloudRecordsBackupState = () => snapshot;

function preferences(): Preferences {
  let value: Partial<Preferences> | null = null;
  try { value = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? "null") as Partial<Preferences> | null; } catch { /* Start with fresh preferences. */ }
  const prefs: Preferences = {
    device: typeof value?.device === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value.device) ? value.device : crypto.randomUUID(),
    enabled: Array.isArray(value?.enabled) ? value.enabled.filter((owner) => typeof owner === "string") : [],
    last: value?.last && typeof value.last === "object" ? value.last : {},
  };
  if (prefs.device !== value?.device) writePreferences(prefs);
  return prefs;
}
function writePreferences(value: Preferences) {
  try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(value)); } catch { /* Backups still run for this visit. */ }
}
function refresh(update: Partial<typeof activity> = {}) {
  activity = { ...activity, ...update };
  const prefs = preferences();
  const owner = getCloudPhotoBackupState().signedIn ? getCloudPhotoBackupState().owner : undefined;
  const last = owner ? prefs.last[owner] : undefined;
  snapshot = { device: prefs.device, enabled: Boolean(owner && prefs.enabled.includes(owner)), ...activity,
    ...(last ? { last: { savedAt: last.savedAt, size: last.size, workouts: last.workouts, foodDays: last.foodDays, weighIns: last.weighIns } } : {}) };
  subscribers.forEach((listener) => listener());
}
function errorMessage(error: unknown) {
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) return "Cloud backup took too long to connect. Your records are safe on this device; it will retry.";
  if (error instanceof TypeError) return "Cloud backup could not connect. Your records are safe on this device; it will retry.";
  return error instanceof Error ? error.message : "Cloud backup could not finish. Your records are safe on this device.";
}

export function isEmptyBackup(backup: Pick<CompleteBackup, "snapshot" | "body">) {
  const { snapshot: data, body } = backup;
  return !data.completed.length && !data.activeWorkout && !data.nutrition?.days.length
    && !body.weighIns.length && !body.measurements.length && !data.bodyProgress?.weighIns.length && !data.bodyProgress?.measurements.length;
}
async function sha256(text: string) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function compressionAvailable() { return typeof CompressionStream === "function" && typeof DecompressionStream === "function"; }
async function gzip(text: string) { return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).blob(); }
async function gunzip(blob: Blob) { return new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).text(); }

async function api<T>(path: string, init: RequestInit = {}, timeout?: number): Promise<{ owner: string; value: T }> {
  const access = await cloudBackupAccess();
  const response = await cloudPhotoFetch(`${access.apiBaseUrl}${path}`, { ...init, headers: { Authorization: `Bearer ${access.token}`, ...init.headers } }, timeout);
  if (!response.ok) {
    const failure = await response.json().catch(() => ({})) as { error?: { message?: string } };
    if (response.status === 401) throw new Error("Sign in again to continue cloud backup.");
    // API Gateway answers unknown routes without the app's error shape.
    if (response.status === 404 && !failure.error) throw new Error("Cloud records backup is not set up on the server yet. Redeploy the backup stack.");
    throw new Error(failure.error?.message ?? "Cloud backup could not connect. Your records are safe on this device.");
  }
  return { owner: access.owner, value: await response.json() as T };
}

// Keeps the earliest pending deadline: steady logging uploads at most every
// 30 seconds instead of postponing the backup until typing stops.
export function scheduleCloudRecordsBackup(delay = UPLOAD_DELAY) {
  if (!snapshot.enabled) return;
  if (timer && due <= Date.now() + delay) return;
  clearTimeout(timer);
  due = Date.now() + delay;
  timer = setTimeout(() => { timer = undefined; void backupCloudRecordsNow(); }, delay);
}

/** Uploads when records changed since this browser's last successful upload, or always when forced. */
export function backupCloudRecordsNow(force = false): Promise<void> {
  if (running) { again = true; return running; }
  clearTimeout(timer); timer = undefined;
  running = upload(force).finally(() => {
    running = undefined;
    if (again) { again = false; scheduleCloudRecordsBackup(1_000); }
  });
  return running;
}

async function upload(force: boolean) {
  const account = getCloudPhotoBackupState();
  const owner = account.owner;
  if (!manager || !owner || !account.signedIn || !preferences().enabled.includes(owner)) return;
  if (navigator.onLine === false) { refresh({ status: "Offline. Cloud backup will retry when you reconnect." }); return; }
  if (!compressionAvailable()) { refresh({ error: "This browser cannot prepare cloud backups. Update it, or download backups from Data → Backup." }); return; }
  try {
    const backup = await createCompleteBackup(manager, false);
    if (isEmptyBackup(backup)) { refresh({ error: "", status: "Nothing to back up from this browser yet." }); return; }
    const text = JSON.stringify(backup);
    const hash = await sha256(JSON.stringify({ ...backup, exportedAt: "" }));
    if (!force && preferences().last[owner]?.hash === hash) { refresh({ error: "", status: "" }); return; }
    refresh({ busy: true, error: "", status: "" });
    const prefs = preferences();
    const { owner: uploadedOwner, value } = await api<{ latest: CloudRecordsSummary }>(
      `/records/${encodeURIComponent(prefs.device)}?name=${encodeURIComponent(manager.getView().name)}`,
      { method: "PUT", headers: { "Content-Type": "application/gzip" }, body: await gzip(text) }, 60_000);
    if (uploadedOwner !== owner) throw new Error("The cloud backup account changed. Try again.");
    const { savedAt, size, workouts, foodDays, weighIns } = value.latest;
    const latest = preferences();
    latest.last[owner] = { savedAt, size, workouts, foodDays, weighIns, hash };
    writePreferences(latest);
    refresh({ busy: false, error: "" });
  } catch (error) {
    refresh({ busy: false, error: errorMessage(error) });
  }
}

export function startCloudRecordsBackup(target: PeerSyncManager) {
  if (manager) return;
  manager = target;
  const changed = () => scheduleCloudRecordsBackup();
  manager.subscribe(changed);
  window.addEventListener(BODY_PROGRESS_EVENT, changed);
  window.addEventListener(FORECAST_HISTORY_CHANGE_EVENT, changed);
  window.addEventListener("online", () => scheduleCloudRecordsBackup(1_000));
  // Leaving the app sends a waiting change at once; returning checks for anything missed.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { if (timer) void backupCloudRecordsNow(); }
    else scheduleCloudRecordsBackup(2_000);
  });
  window.addEventListener("storage", (event) => { if (event.key === PREFERENCES_KEY) refresh(); });
  subscribeCloudPhotoBackup(() => refresh());
  refresh();
  void initializeCloudPhotoBackup().then(() => {
    const account = getCloudPhotoBackupState();
    if (account.signedIn && account.owner && sessionStorage.getItem(ENABLE_FLAG) === "yes") {
      sessionStorage.removeItem(ENABLE_FLAG);
      const prefs = preferences();
      if (!prefs.enabled.includes(account.owner)) prefs.enabled.push(account.owner);
      writePreferences(prefs);
    }
    refresh();
    scheduleCloudRecordsBackup(2_000);
  });
}

export async function enableCloudRecordsBackup() {
  await initializeCloudPhotoBackup();
  const account = getCloudPhotoBackupState();
  if (!account.available) return;
  if (!account.signedIn || !account.owner) {
    await signInForCloudBackup(ENABLE_FLAG).catch((error: unknown) => refresh({ error: errorMessage(error) }));
    return;
  }
  const prefs = preferences();
  if (!prefs.enabled.includes(account.owner)) prefs.enabled.push(account.owner);
  writePreferences(prefs);
  refresh({ error: "" });
  await backupCloudRecordsNow();
}
export function pauseCloudRecordsBackup() {
  const owner = getCloudPhotoBackupState().owner;
  const prefs = preferences();
  prefs.enabled = prefs.enabled.filter((value) => value !== owner);
  writePreferences(prefs);
  clearTimeout(timer); timer = undefined;
  refresh({ error: "", status: "" });
}
export async function signInToRestoreCloudRecords() {
  await signInForCloudBackup("rolling-ppl:restore-records-sign-in").catch((error: unknown) => refresh({ error: errorMessage(error) }));
}

export async function listCloudRecordsCopies(): Promise<CloudRecordsDevice[]> {
  const { value } = await api<{ devices: CloudRecordsDevice[] }>("/records");
  if (!Array.isArray(value.devices)) throw new Error("Cloud backup returned an invalid list. Try again.");
  return value.devices;
}
export async function fetchCloudRecordsCopy(device: string, copy: string): Promise<ReadyBackup> {
  if (!compressionAvailable()) throw new Error("This browser cannot open cloud backups. Update it and try again.");
  const { value } = await api<{ url: string }>(`/records/${encodeURIComponent(device)}/download?copy=${encodeURIComponent(copy)}`);
  const response = await cloudPhotoFetch(value.url, {}, 60_000);
  if (!response.ok) throw new Error("This cloud copy could not be downloaded. Try again.");
  let parsed: unknown;
  try { parsed = JSON.parse(await gunzip(await response.blob())); }
  catch { throw new Error("This cloud copy could not be read. Try another copy."); }
  return parseCompleteBackup(parsed);
}
export async function restoreCloudRecords(ready: ReadyBackup) {
  if (!manager) throw new Error("The app is still starting. Try again in a moment.");
  await restoreCompleteBackup(manager, ready);
  scheduleCloudRecordsBackup(2_000);
}

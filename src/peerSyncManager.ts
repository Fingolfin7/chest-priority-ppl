import * as A from "@automerge/automerge";
import { createSyncDoc, updateSyncDoc, projectSyncDoc, listSyncConflicts, resolveSyncConflict, validateSyncDoc, migrateExerciseAliases, type SyncSnapshot, type SyncData } from "./peerSyncModel.ts";
import { createIdentity, type DeviceIdentity } from "./peerSyncCrypto.ts";
import { PeerSyncTransport, type PairedDevice } from "./peerSyncTransport.ts";
import { recoveryJournal, recoverySnapshots, type RecoveryJournal } from "./recoveryJournal.ts";

// Version 1 kept everything, including a full document save, in one "current"
// record rewritten on every change. Version 2 keeps small metadata, a compacted
// document and appended incremental changes in the same object store (no
// IndexedDB schema upgrade, so an older open tab can never block startup); it
// migrates version 1 on the first save.
type LegacyPersisted = {
  version: 1; document: Uint8Array; identity: DeviceIdentity; devices: PairedDevice[];
  name: string; enabled: boolean; revoked: string[]; original: SyncSnapshot;
};
type Metadata = { version: 2; identity: DeviceIdentity; devices: PairedDevice[]; name: string; enabled: boolean; revoked: string[] };
type StoredState = { legacy?: LegacyPersisted; meta?: Metadata; document?: Uint8Array; changes: Uint8Array[] };
export type SyncView = {
  enabled: boolean; status: string; error: string; name: string; invite: string;
  devices: Array<PairedDevice & { connected: boolean; current: boolean }>;
  conflicts: ReturnType<typeof listSyncConflicts>; removed: boolean;
};
const RECOVERY_KEY = "rolling-ppl-sync-recovery-v1";
// Appended change chunks are folded into one full save after this many writes.
const COMPACT_AFTER = 100;
const CHANGE_PREFIX = "change:";
const changeKey = (sequence: number) => `${CHANGE_PREFIX}${String(sequence).padStart(12, "0")}`;
const changeRange = () => IDBKeyRange.bound(CHANGE_PREFIX, `${CHANGE_PREFIX}\uffff`);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function heads(doc: A.Doc<SyncData>) { return JSON.stringify(A.getHeads(doc).sort()); }
function packet(type: number, body: Uint8Array) {
  const result = new Uint8Array(body.length + 1); result[0] = type; result.set(body, 1); return result;
}
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // No version argument: an existing database is opened as-is and never upgraded.
    const request = indexedDB.open("rolling-ppl-peer-sync-v1");
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains("state")) request.result.createObjectStore("state"); };
    request.onsuccess = () => {
      const db = request.result;
      // Never be the tab that blocks a future version's upgrade.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Close other Rolling PPL tabs, then reload."));
  });
}
function readState(db: IDBDatabase): Promise<StoredState> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("state", "readonly");
    const state = transaction.objectStore("state");
    const legacy = state.get("current"), meta = state.get("meta"), document = state.get("document"), changes = state.getAll(changeRange());
    transaction.oncomplete = () => resolve({ legacy: legacy.result, meta: meta.result, document: document.result, changes: changes.result as Uint8Array[] });
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Local sync data could not be read."));
  });
}
type StateWrite = { meta: Metadata; document?: Uint8Array; change?: { key: string; bytes: Uint8Array }; original?: SyncSnapshot };
function writeState(db: IDBDatabase, write: StateWrite): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("state", "readwrite");
    const state = transaction.objectStore("state");
    state.put(write.meta, "meta");
    if (write.document) { state.put(write.document, "document"); state.delete(changeRange()); state.delete("current"); }
    if (write.change) state.put(write.change.bytes, write.change.key);
    if (write.original) state.put(write.original, "original");
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Local save was interrupted."));
  });
}
// Keep unchanged branches of the previous snapshot so React, the localStorage
// mirrors and the crash journal only see the parts that actually changed.
export function reuseUnchanged<T>(previous: T, next: T): T {
  if (Object.is(previous, next) || !previous || !next || typeof previous !== "object" || typeof next !== "object") return next;
  if (Array.isArray(next)) {
    if (!Array.isArray(previous)) return next;
    let same = previous.length === next.length;
    const merged = next.map((item, index) => { const kept = reuseUnchanged(previous[index], item); if (kept !== previous[index]) same = false; return kept; });
    return (same ? previous : merged) as T;
  }
  if (Array.isArray(previous)) return next;
  const before = previous as Record<string, unknown>, after = next as Record<string, unknown>;
  const keys = Object.keys(after);
  let same = keys.length === Object.keys(before).length;
  const merged: Record<string, unknown> = {};
  for (const key of keys) {
    const kept = Object.hasOwn(before, key) ? reuseUnchanged(before[key], after[key]) : after[key];
    if (!Object.hasOwn(before, key) || kept !== before[key]) same = false;
    // Exercise names are user data; never let a key such as "__proto__" act as a setter.
    Object.defineProperty(merged, key, { value: kept, enumerable: true, configurable: true, writable: true });
  }
  return (same ? previous : merged) as T;
}

/** One store owns the React snapshot and replicated history. Typing updates the
 * snapshot and crash journal immediately; replication is batched between edits. */
export class PeerSyncManager {
  private doc: A.Doc<SyncData>;
  private snapshot: SyncSnapshot;
  private durableSnapshot: SyncSnapshot;
  private seed?: () => SyncSnapshot;
  private pendingOriginal?: SyncSnapshot;
  private persistedHeads?: A.Heads;
  private changeCount = 0;
  // Set when startup could not use IndexedDB: the visit keeps working from memory,
  // the localStorage mirrors and the crash journal, and never overwrites stored data.
  private storageDisabled = false;
  private identity!: DeviceIdentity;
  private db?: IDBDatabase;
  private transport?: PeerSyncTransport;
  private devices: PairedDevice[] = [];
  private revoked = new Set<string>();
  private connected = new Set<string>();
  private states = new Map<string, A.SyncState>();
  private epochs = new Map<string, number>();
  private acknowledged = new Map<string, string>();
  private listeners = new Set<() => void>();
  private dataListeners = new Set<() => void>();
  private saving: Promise<void> = Promise.resolve();
  private receiving: Promise<void> = Promise.resolve();
  private scheduled = false;
  private inputBaseline?: SyncSnapshot;
  private inputTimer?: ReturnType<typeof setTimeout>;
  private inputDeadline?: ReturnType<typeof setTimeout>;
  private view: SyncView = { enabled: false, status: "Pair a browser to start syncing.", error: "", name: "My browser", invite: "", devices: [], conflicts: [], removed: false };
  /** A seed function is only called when this browser has no saved sync data
   * (or storage fails), so normal starts skip rebuilding a throwaway document. */
  constructor(initial: SyncSnapshot | (() => SyncSnapshot)) {
    if (typeof initial === "function") { this.seed = initial; this.doc = createSyncDoc(); }
    else this.doc = createSyncDoc(initial);
    this.snapshot = projectSyncDoc(this.doc);
    this.durableSnapshot = this.snapshot;
  }
  private plant() {
    if (!this.seed) return;
    const initial = this.seed(); this.seed = undefined;
    this.pendingOriginal = structuredClone(initial);
    this.doc = createSyncDoc(initial);
    this.snapshot = projectSyncDoc(this.doc); this.durableSnapshot = this.snapshot;
  }
  getSnapshot = () => this.snapshot;
  async saveNow() { await this.durable(); }
  getView = () => this.view;
  subscribe = (listener: () => void) => { this.dataListeners.add(listener); return () => { this.dataListeners.delete(listener); }; };
  subscribeView = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private refresh(patch: Partial<SyncView> = {}) {
    this.view = { ...this.view, ...patch, removed: Boolean(this.identity && this.revoked.has(this.identity.id)),
      devices: this.devices.map((device) => ({ ...device, connected: this.connected.has(device.id), current: this.acknowledged.get(device.id) === heads(this.doc) })),
      conflicts: listSyncConflicts(this.doc) };
    this.listeners.forEach((listener) => listener());
  }
  private publish(inputBaseline?: SyncSnapshot) {
    this.snapshot = reuseUnchanged(this.snapshot, projectSyncDoc(this.doc));
    // Draft commits cannot change history, receipts, or the active workout.
    // Retain their references so React does not rewrite the history mirrors.
    if (inputBaseline) this.snapshot = { ...this.snapshot, history: inputBaseline.history, completed: inputBaseline.completed, activeWorkout: inputBaseline.activeWorkout };
    this.dataListeners.forEach((listener) => listener());
    this.refresh();
  }
  private fail(error: unknown) { this.refresh({ error: error instanceof Error ? error.message : "Device sync could not complete." }); }
  async initialize() {
    try {
      this.db = await openDatabase();
      const stored = await readState(this.db);
      const saved = stored.meta ?? stored.legacy;
      if (saved) {
        if (stored.meta ? stored.meta.version !== 2 || !stored.document : stored.legacy!.version !== 1) throw new Error("This sync data needs a newer version of Rolling PPL.");
        let doc = A.load<SyncData>(stored.meta ? stored.document! : stored.legacy!.document);
        for (const change of stored.meta ? stored.changes : []) doc = A.loadIncremental(doc, change);
        this.doc = doc; this.seed = undefined;
        validateSyncDoc(this.doc);
        this.durableSnapshot = projectSyncDoc(this.doc);
        // A single synchronous journal recovers edits made just before a page
        // exits, without reconstructing them from partially written mirror keys.
        const journal = localStorage.getItem(RECOVERY_KEY);
        if (journal) {
          const recovery = recoverySnapshots(this.durableSnapshot, JSON.parse(journal) as RecoveryJournal);
          this.doc = updateSyncDoc(this.doc, recovery.before, recovery.after);
        }
        this.doc = migrateExerciseAliases(this.doc);
        this.identity = saved.identity; this.devices = saved.devices; this.revoked = new Set(saved.revoked);
        // The one-time pre-sync snapshot moves to its own record and is never rewritten.
        if (stored.legacy?.original) this.pendingOriginal = stored.legacy.original;
        this.view = { ...this.view, name: saved.name, enabled: saved.enabled };
      } else {
        this.plant();
        this.identity = await createIdentity();
        this.view = { ...this.view, name: /Android|iPhone|iPad/i.test(navigator.userAgent) ? "My phone" : "My laptop" };
      }
      this.publish(); await this.persist();
      if (this.view.enabled && !this.view.removed) this.startTransport();
    } catch (error) {
      // Storage failed: keep working from the localStorage copy for this visit,
      // and stop writing so a partly loaded state can never replace stored data.
      this.db?.close(); this.db = undefined; this.storageDisabled = true;
      try { if (this.seed) { this.plant(); this.publish(); } } catch { /* The empty document still lets the app open. */ }
      this.refresh({ enabled: false });
      this.fail(new Error(`Device sync is unavailable: ${error instanceof Error ? error.message : "local storage failed"}. Your workout copy is still available.`));
    }
  }
  set<K extends keyof SyncSnapshot>(key: K, action: SyncSnapshot[K] | ((previous: SyncSnapshot[K]) => SyncSnapshot[K])) {
    const value = typeof action === "function" ? (action as (previous: SyncSnapshot[K]) => SyncSnapshot[K])(this.snapshot[key]) : action;
    if (value === this.snapshot[key]) return;
    if (key === "drafts" || key === "bodyweight" || key === "sessionNote") {
      this.inputBaseline ??= this.snapshot;
      this.snapshot = { ...this.snapshot, [key]: value };
      this.journal();
      this.dataListeners.forEach((listener) => listener());
      clearTimeout(this.inputTimer);
      this.inputTimer = setTimeout(() => this.flushPendingInputs(), 250);
      this.inputDeadline ??= setTimeout(() => this.flushPendingInputs(), 1000);
      return;
    }
    this.change({ ...this.snapshot, [key]: value });
  }
  flushPendingInputs() {
    if (!this.inputBaseline) return;
    const baseline = this.inputBaseline;
    const updated = updateSyncDoc(this.doc, baseline, this.snapshot);
    clearTimeout(this.inputTimer); clearTimeout(this.inputDeadline);
    this.inputTimer = undefined; this.inputDeadline = undefined; this.inputBaseline = undefined;
    if (updated === this.doc) return;
    this.doc = updated; this.publish(baseline); this.journal(); this.schedule();
  }
  change(next: SyncSnapshot) {
    this.flushPendingInputs();
    const updated = updateSyncDoc(this.doc, this.snapshot, next);
    if (updated === this.doc) return;
    this.doc = updated; this.publish(); this.journal(); this.schedule();
  }
  resolve(key: string, optionId: string) {
    this.flushPendingInputs();
    this.doc = resolveSyncConflict(this.doc, key, optionId); this.publish(); this.journal(); this.schedule();
  }
  private journal() {
    try { localStorage.setItem(RECOVERY_KEY, JSON.stringify(recoveryJournal(this.durableSnapshot, this.snapshot))); }
    catch { this.fail(new Error("Crash recovery could not save. Keep this page open until synced or export a backup.")); }
  }
  reportError(message: string) { this.fail(new Error(message)); }
  private persist() {
    this.flushPendingInputs();
    if (this.storageDisabled) return Promise.resolve();
    if (!this.db || !this.identity) return Promise.reject(new Error("This browser could not open its sync storage."));
    const baseline = this.snapshot, doc = this.doc, db = this.db;
    const meta: Metadata = { version: 2, identity: this.identity, devices: this.devices, name: this.view.name, enabled: this.view.enabled, revoked: [...this.revoked] };
    // Writes run in order; each appends only the changes since the last
    // committed write, and the first write after loading compacts everything.
    const work = this.saving.catch(() => {}).then(async () => {
      const heads = A.getHeads(doc);
      const compact = !this.persistedHeads || this.changeCount >= COMPACT_AFTER;
      const changed = !compact && [...heads].sort().join() !== [...this.persistedHeads!].sort().join();
      const original = this.pendingOriginal;
      await writeState(db, { meta, ...(compact ? { document: A.save(doc) } : changed ? { change: { key: changeKey(this.changeCount), bytes: A.saveSince(doc, this.persistedHeads!) } } : {}), ...(original ? { original } : {}) });
      if (original === this.pendingOriginal) this.pendingOriginal = undefined;
      this.persistedHeads = heads; this.changeCount = compact ? 0 : this.changeCount + Number(changed);
      this.durableSnapshot = baseline; this.journal();
    });
    this.saving = work; return work;
  }
  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.broadcast().catch((error) => this.fail(new Error(`Local sync save failed: ${String(error)}. Keep this page open and export a backup.`)));
    });
  }
  private async durable() {
    this.flushPendingInputs();
    // Never acknowledge a received change before IndexedDB commits it.
    for (;;) { const before = heads(this.doc); await this.persist(); if (before === heads(this.doc)) return; }
  }
  private startTransport() {
    if (this.transport || !this.identity || this.view.removed) return;
    const transport = new PeerSyncTransport({
      identity: this.identity, name: this.view.name, devices: this.devices.filter((device) => !this.revoked.has(device.id)),
      onStatus: (status) => { if (this.transport === transport) this.refresh({ status }); },
      onPaired: (device) => {
        if (this.transport !== transport) return;
        if (this.revoked.has(device.id)) { this.transport?.disconnect(device.id); return; }
        this.devices = [...this.devices.filter((entry) => entry.id !== device.id), device];
        this.refresh({ invite: "", error: "" }); this.schedule();
      },
      onConnected: (id) => {
        if (this.transport !== transport) return;
        if (this.revoked.has(id)) { this.transport?.disconnect(id); return; }
        const epoch = (this.epochs.get(id) ?? 0) + 1; this.epochs.set(id, epoch);
        this.connected.add(id); this.states.set(id, A.initSyncState()); this.acknowledged.delete(id); this.refresh();
        void this.sendInitial(id, transport, epoch).catch((error) => { if (this.isConnection(id, transport, epoch)) this.fail(error); });
      },
      onDisconnected: (id) => {
        if (this.transport !== transport) return;
        this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
        this.connected.delete(id); this.states.delete(id); this.acknowledged.delete(id); this.refresh();
      },
      onMessage: (id, message) => {
        const epoch = this.epochs.get(id) ?? 0;
        this.receiving = this.receiving.then(() => this.receive(id, message, transport, epoch)).catch((error) => {
          if (this.isConnection(id, transport, epoch)) { transport.disconnect(id); this.fail(error); }
        });
      },
    });
    this.transport = transport;
    transport.start();
  }
  async enable() {
    if (!this.db || !this.identity) throw new Error("Device sync storage is unavailable. Close other Rolling PPL tabs, then reload.");
    if (this.view.removed) { this.identity = await createIdentity(); this.devices = []; this.refresh(); }
    this.refresh({ enabled: true, error: "" }); await this.persist(); this.startTransport();
  }
  async pause() {
    this.transport?.stop(); this.transport = undefined; this.connected.clear(); this.states.clear(); this.acknowledged.clear();
    this.refresh({ enabled: false, invite: "", status: "Sync paused. Workouts still save locally." }); await this.persist();
  }
  async resetPairing() {
    if (!this.identity || !this.db) throw new Error("Device sync storage is unavailable. Reload and try again.");
    this.revoked.add(this.identity.id);
    await Promise.allSettled([...this.connected].map((peer) => this.sendRevocations(peer)));
    await this.pause();
    this.identity = await createIdentity(); this.devices = [];
    this.refresh({ invite: "", error: "", status: "Pairing reset. Your workouts are still here. Add or pair a device to reconnect." });
    await this.persist();
  }
  async rename(name: string) {
    const trimmed = name.trim().slice(0, 60); if (!trimmed) return;
    const wasEnabled = this.view.enabled;
    this.transport?.stop(); this.transport = undefined; this.connected.clear(); this.states.clear(); this.acknowledged.clear();
    this.refresh({ name: trimmed, invite: "" }); await this.persist(); if (wasEnabled) this.startTransport();
  }
  async createInvite() {
    if (!this.view.enabled) await this.enable();
    if (!this.transport) throw new Error("Device connection is unavailable.");
    const invite = await this.transport.createInvite(); this.refresh({ invite, error: "" }); return invite;
  }
  cancelInvite() { this.transport?.cancelInvite(); this.refresh({ invite: "" }); }
  async join(invite: string) {
    if (!this.view.enabled) await this.enable();
    if (!this.transport) throw new Error("Device connection is unavailable.");
    await this.transport.joinInvite(invite); this.refresh({ error: "" });
  }
  async remove(id: string) {
    this.revoked.add(id); this.devices = this.devices.filter((device) => device.id !== id); await this.persist();
    await Promise.allSettled([...this.connected].map((peer) => this.sendRevocations(peer)));
    this.transport?.disconnect(id); this.transport?.setDevices(this.devices);
    this.connected.delete(id); this.states.delete(id); this.acknowledged.delete(id); this.refresh();
  }
  reconnect() {
    this.transport?.stop(); this.transport = undefined;
    this.connected.clear(); this.states.clear(); this.acknowledged.clear();
    this.refresh({ error: "" });
    if (this.view.enabled) this.startTransport();
    this.schedule();
  }
  private sendRevocations(id: string) {
    return this.transport?.send(id, packet(2, encoder.encode(JSON.stringify([...this.revoked])))) ?? Promise.resolve();
  }
  private isConnection(id: string, transport: PeerSyncTransport, epoch: number) {
    return this.transport === transport && this.connected.has(id) && this.epochs.get(id) === epoch && !this.revoked.has(id);
  }
  private async sendInitial(id: string, transport: PeerSyncTransport, epoch: number) {
    await this.durable();
    if (!this.isConnection(id, transport, epoch)) return;
    await this.sendRevocations(id);
    if (this.isConnection(id, transport, epoch)) await this.sendSync(id);
  }
  private async sendSync(id: string) {
    const state = this.states.get(id); if (!state || !this.transport || this.revoked.has(id)) return;
    const [nextState, message] = A.generateSyncMessage(this.doc, state); this.states.set(id, nextState);
    if (message) await this.transport.send(id, packet(1, message));
  }
  private async broadcast() {
    await this.durable();
    const transport = this.transport;
    const peers = [...this.connected];
    const epochs = peers.map((id) => this.epochs.get(id) ?? 0);
    const results = await Promise.allSettled(peers.map((id) => this.sendSync(id)));
    results.forEach((result, index) => {
      if (result.status === "rejected" && transport && this.isConnection(peers[index], transport, epochs[index])) { transport.disconnect(peers[index]); this.fail(new Error("A device transfer was interrupted. Your changes are saved here; choose Sync now to retry.")); }
    });
  }
  private async receive(id: string, message: Uint8Array, transport: PeerSyncTransport, epoch: number) {
    if (!this.isConnection(id, transport, epoch)) return;
    if (!message.length || message.length > 8 * 1024 * 1024) throw new Error("A device sent an invalid sync message.");
    this.flushPendingInputs();
    if (message[0] === 2) {
      const removed: unknown = JSON.parse(decoder.decode(message.subarray(1)));
      if (!Array.isArray(removed) || removed.length > 1000 || removed.some((entry) => typeof entry !== "string" || entry.length > 120)) throw new Error("Invalid device removal message.");
      if (!removed.some((entry: string) => !this.revoked.has(entry))) return;
      removed.forEach((entry: string) => this.revoked.add(entry));
      this.devices = this.devices.filter((device) => !this.revoked.has(device.id)); await this.persist();
      if (this.transport !== transport) return;
      if (this.revoked.has(this.identity.id)) {
        this.transport.stop(); this.transport = undefined; this.connected.clear(); this.states.clear(); this.acknowledged.clear();
        this.refresh({ enabled: false, status: "This browser was removed. Pair it again to resume syncing.", invite: "" }); await this.persist(); return;
      }
      this.transport.setDevices(this.devices);
      for (const peer of this.connected) if (this.revoked.has(peer)) { this.transport.disconnect(peer); this.connected.delete(peer); this.states.delete(peer); }
      this.refresh(); await Promise.allSettled([...this.connected].map((peer) => this.sendRevocations(peer))); return;
    }
    if (message[0] === 3) {
      if (decoder.decode(message.subarray(1)) === heads(this.doc)) {
        this.acknowledged.set(id, heads(this.doc));
        this.devices = this.devices.map((device) => device.id === id ? { ...device, lastSyncedAt: new Date().toISOString() } : device);
        await this.persist(); this.refresh();
      }
      return;
    }
    if (message[0] !== 1) throw new Error("This device uses an unsupported sync protocol.");
    const state = this.states.get(id) ?? A.initSyncState();
    const [received, nextState] = A.receiveSyncMessage(A.clone(this.doc), state, message.subarray(1));
    validateSyncDoc(received);
    const upgraded = migrateExerciseAliases(received);
    const changed = heads(upgraded) !== heads(this.doc);
    this.doc = upgraded; this.states.set(id, nextState);
    if (changed) { this.publish(); this.journal(); }
    await this.durable();
    if (!this.isConnection(id, transport, epoch)) return;
    await this.sendSync(id);
    if (!this.isConnection(id, transport, epoch)) return;
    await transport.send(id, packet(3, encoder.encode(heads(this.doc))));
    if (changed) await this.broadcast();
  }
}

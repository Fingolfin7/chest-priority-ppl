import * as A from "@automerge/automerge";
import { createSyncDoc, updateSyncDoc, projectSyncDoc, listSyncConflicts, resolveSyncConflict, validateSyncDoc, type SyncSnapshot, type SyncData } from "./peerSyncModel.ts";
import { createIdentity, type DeviceIdentity } from "./peerSyncCrypto.ts";
import { PeerSyncTransport, type PairedDevice, type PairRequest } from "./peerSyncTransport.ts";

type Persisted = {
  version: 1; document: Uint8Array; identity: DeviceIdentity; devices: PairedDevice[];
  name: string; enabled: boolean; revoked: string[]; original: SyncSnapshot;
};
export type SyncView = {
  enabled: boolean; status: string; error: string; name: string; invite: string;
  request: PairRequest | null; devices: Array<PairedDevice & { connected: boolean; current: boolean }>;
  conflicts: ReturnType<typeof listSyncConflicts>; removed: boolean;
};
const RECOVERY_KEY = "rolling-ppl-sync-recovery-v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function heads(doc: A.Doc<SyncData>) { return JSON.stringify(A.getHeads(doc).sort()); }
function packet(type: number, body: Uint8Array) {
  const result = new Uint8Array(body.length + 1); result[0] = type; result.set(body, 1); return result;
}
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("rolling-ppl-peer-sync-v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("state");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Close other Rolling PPL tabs, then reload."));
  });
}
function readState(db: IDBDatabase): Promise<Persisted | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction("state", "readonly").objectStore("state").get("current");
    request.onsuccess = () => resolve(request.result as Persisted | undefined);
    request.onerror = () => reject(request.error);
  });
}
function writeState(db: IDBDatabase, state: Persisted): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("state", "readwrite");
    transaction.objectStore("state").put(state, "current");
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Local save was interrupted."));
  });
}

/** One store owns the React snapshot and the replicated history. UI setters and
 * incoming messages both update it synchronously; only disk/network I/O queues. */
export class PeerSyncManager {
  private doc: A.Doc<SyncData>;
  private snapshot: SyncSnapshot;
  private durableSnapshot: SyncSnapshot;
  private original: SyncSnapshot;
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
  private view: SyncView = { enabled: false, status: "Pair a browser to start syncing.", error: "", name: "My browser", invite: "", request: null, devices: [], conflicts: [], removed: false };
  constructor(initial: SyncSnapshot) {
    this.original = structuredClone(initial);
    this.doc = createSyncDoc(initial);
    this.snapshot = projectSyncDoc(this.doc);
    this.durableSnapshot = this.snapshot;
  }
  getSnapshot = () => this.snapshot;
  getView = () => this.view;
  subscribe = (listener: () => void) => { this.dataListeners.add(listener); return () => { this.dataListeners.delete(listener); }; };
  subscribeView = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private refresh(patch: Partial<SyncView> = {}) {
    this.view = { ...this.view, ...patch, removed: Boolean(this.identity && this.revoked.has(this.identity.id)),
      devices: this.devices.map((device) => ({ ...device, connected: this.connected.has(device.id), current: this.acknowledged.get(device.id) === heads(this.doc) })),
      conflicts: listSyncConflicts(this.doc) };
    this.listeners.forEach((listener) => listener());
  }
  private publish() {
    this.snapshot = projectSyncDoc(this.doc);
    this.dataListeners.forEach((listener) => listener());
    this.refresh();
  }
  private fail(error: unknown) { this.refresh({ error: error instanceof Error ? error.message : "Device sync could not complete." }); }
  async initialize() {
    try {
      this.db = await openDatabase();
      const saved = await readState(this.db);
      if (saved) {
        if (saved.version !== 1) throw new Error("This sync data needs a newer version of Rolling PPL.");
        this.doc = A.load<SyncData>(saved.document);
        validateSyncDoc(this.doc);
        this.durableSnapshot = projectSyncDoc(this.doc);
        // A single synchronous journal recovers edits made just before a page
        // exits, without reconstructing them from partially written mirror keys.
        const journal = localStorage.getItem(RECOVERY_KEY);
        if (journal) {
          const recovery = JSON.parse(journal) as { before: SyncSnapshot; after: SyncSnapshot };
          this.doc = updateSyncDoc(this.doc, recovery.before, recovery.after);
        }
        this.identity = saved.identity; this.devices = saved.devices; this.revoked = new Set(saved.revoked);
        this.original = saved.original;
        this.view = { ...this.view, name: saved.name, enabled: saved.enabled };
      } else {
        this.identity = await createIdentity();
        this.view = { ...this.view, name: /Android|iPhone|iPad/i.test(navigator.userAgent) ? "My phone" : "My laptop" };
      }
      this.publish(); await this.persist();
      if (this.view.enabled && !this.view.removed) this.startTransport();
    } catch (error) {
      this.refresh({ enabled: false });
      this.fail(new Error(`Device sync is unavailable: ${error instanceof Error ? error.message : "local storage failed"}. Your workout copy is still available.`));
    }
  }
  set<K extends keyof SyncSnapshot>(key: K, action: SyncSnapshot[K] | ((previous: SyncSnapshot[K]) => SyncSnapshot[K])) {
    const value = typeof action === "function" ? (action as (previous: SyncSnapshot[K]) => SyncSnapshot[K])(this.snapshot[key]) : action;
    this.change({ ...this.snapshot, [key]: value });
  }
  change(next: SyncSnapshot) {
    const updated = updateSyncDoc(this.doc, this.snapshot, next);
    if (updated === this.doc) return;
    this.doc = updated; this.publish(); this.journal(); this.schedule();
  }
  resolve(key: string, optionId: string) {
    this.doc = resolveSyncConflict(this.doc, key, optionId); this.publish(); this.journal(); this.schedule();
  }
  private journal() {
    try { localStorage.setItem(RECOVERY_KEY, JSON.stringify({ before: this.durableSnapshot, after: this.snapshot })); }
    catch { this.fail(new Error("Crash recovery could not save. Keep this page open until synced or export a backup.")); }
  }
  private persist() {
    if (!this.db || !this.identity) return Promise.reject(new Error("This browser could not open its sync storage."));
    const baseline = this.snapshot;
    const state: Persisted = { version: 1, document: A.save(this.doc), identity: this.identity,
      devices: this.devices, name: this.view.name, enabled: this.view.enabled, revoked: [...this.revoked], original: this.original };
    const db = this.db;
    const work = this.saving.catch(() => {}).then(async () => {
      await writeState(db, state); this.durableSnapshot = baseline; this.journal();
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
    // Never acknowledge a received change before IndexedDB commits it.
    for (;;) { const before = heads(this.doc); await this.persist(); if (before === heads(this.doc)) return; }
  }
  private startTransport() {
    if (this.transport || !this.identity || this.view.removed) return;
    const transport = new PeerSyncTransport({
      identity: this.identity, name: this.view.name, devices: this.devices.filter((device) => !this.revoked.has(device.id)),
      onStatus: (status) => { if (this.transport === transport) this.refresh({ status }); },
      onPairRequest: (request) => {
        if (this.transport !== transport) return;
        if (this.revoked.has(request.id)) { this.transport?.rejectPair(request.id); return; }
        this.refresh({ request });
      },
      onPaired: (device) => {
        if (this.transport !== transport) return;
        if (this.revoked.has(device.id)) { this.transport?.disconnect(device.id); return; }
        this.devices = [...this.devices.filter((entry) => entry.id !== device.id), device];
        this.refresh({ invite: "", request: null, error: "" }); this.schedule();
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
    if (!this.db || !this.identity) throw new Error("Device sync storage is unavailable. Reload and try again.");
    if (this.view.removed) { this.identity = await createIdentity(); this.devices = []; this.refresh(); }
    this.refresh({ enabled: true, error: "" }); await this.persist(); this.startTransport();
  }
  async pause() {
    this.transport?.stop(); this.transport = undefined; this.connected.clear(); this.states.clear(); this.acknowledged.clear();
    this.refresh({ enabled: false, invite: "", request: null, status: "Sync paused. Workouts still save locally." }); await this.persist();
  }
  async resetPairing() {
    if (!this.identity || !this.db) throw new Error("Device sync storage is unavailable. Reload and try again.");
    this.revoked.add(this.identity.id);
    await Promise.allSettled([...this.connected].map((peer) => this.sendRevocations(peer)));
    await this.pause();
    this.identity = await createIdentity(); this.devices = [];
    this.refresh({ invite: "", request: null, error: "", status: "Pairing reset. Your workouts are still here. Add or pair a device to reconnect." });
    await this.persist();
  }
  async rename(name: string) {
    const trimmed = name.trim().slice(0, 60); if (!trimmed) return;
    const wasEnabled = this.view.enabled;
    this.transport?.stop(); this.transport = undefined; this.connected.clear(); this.states.clear(); this.acknowledged.clear();
    this.refresh({ name: trimmed, invite: "", request: null }); await this.persist(); if (wasEnabled) this.startTransport();
  }
  async createInvite() {
    if (!this.view.enabled) await this.enable();
    if (!this.transport) throw new Error("Device connection is unavailable.");
    const invite = await this.transport.createInvite(true); this.refresh({ invite, error: "" }); return invite;
  }
  cancelInvite() { this.transport?.cancelInvite(); this.refresh({ invite: "", request: null }); }
  async join(invite: string) {
    if (!this.view.enabled) await this.enable();
    if (!this.transport) throw new Error("Device connection is unavailable.");
    await this.transport.joinInvite(invite); this.refresh({ error: "" });
  }
  async approve(id: string) {
    if (!this.transport) throw new Error("Device connection is unavailable.");
    await this.transport.approvePair(id); this.refresh({ request: null, invite: "" });
  }
  reject(id: string) { this.transport?.rejectPair(id); this.refresh({ request: null }); }
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
    if (message[0] === 2) {
      const removed: unknown = JSON.parse(decoder.decode(message.subarray(1)));
      if (!Array.isArray(removed) || removed.length > 1000 || removed.some((entry) => typeof entry !== "string" || entry.length > 120)) throw new Error("Invalid device removal message.");
      if (!removed.some((entry: string) => !this.revoked.has(entry))) return;
      removed.forEach((entry: string) => this.revoked.add(entry));
      this.devices = this.devices.filter((device) => !this.revoked.has(device.id)); await this.persist();
      if (this.transport !== transport) return;
      if (this.revoked.has(this.identity.id)) {
        this.transport.stop(); this.transport = undefined; this.connected.clear(); this.states.clear(); this.acknowledged.clear();
        this.refresh({ enabled: false, status: "This browser was removed. Pair it again to resume syncing.", invite: "", request: null }); await this.persist(); return;
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
    const changed = heads(received) !== heads(this.doc);
    this.doc = received; this.states.set(id, nextState);
    if (changed) { this.publish(); this.journal(); }
    await this.durable();
    if (!this.isConnection(id, transport, epoch)) return;
    await this.sendSync(id);
    if (!this.isConnection(id, transport, epoch)) return;
    await transport.send(id, packet(3, encoder.encode(heads(this.doc))));
    if (changed) await this.broadcast();
  }
}

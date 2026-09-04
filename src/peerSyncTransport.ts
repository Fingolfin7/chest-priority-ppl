import Peer, { type DataConnection, type PeerOptions } from 'peerjs';
import { createInvitation, createSecureChannel, decodeBytes, deviceId, encodeBytes, pairingProof, parseInvitation, randomToken, verifyPairingProof, type DeviceIdentity, type PairInvite, type SealedFrame, type SecureChannel } from './peerSyncCrypto.ts';
export type PairedDevice = { id: string; publicKey: string; name: string; lastSyncedAt?: string };
export type PairRequest = PairedDevice;
export type PeerSyncTransportOptions = {
  identity: DeviceIdentity; name: string; devices: PairedDevice[]; peerOptions?: Partial<PeerOptions>;
  onStatus(status: string): void; onPairRequest(request: PairRequest): void; onPaired(device: PairedDevice): void;
  onMessage(peerId: string, message: Uint8Array): void; onConnected(peerId: string): void; onDisconnected(peerId: string): void;
};
type Hello = { v: 1; type: 'hello'; publicKey: string; name: string; nonce: string; proof?: string; expiresAt?: number };
type Assembly = { id: string; total: number; next: number; chunks: Uint8Array[]; bytes: number; started: number };
type Connection = {
  connection: DataConnection; outbound: boolean; nonce: string; invite?: PairInvite; localHello?: Hello; remote?: PairedDevice;
  channel?: SecureChannel; authenticated: boolean; approved: boolean; active: boolean; closed: boolean; requested: boolean;
  incoming: Promise<void>; outgoing: Promise<void>; queuedBytes: number; incomingBytes: number; timer: ReturnType<typeof setTimeout>; assembly?: Assembly;
};
const CHUNK_BYTES = 12_000;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_WIRE_BYTES = 44_000;
const MAX_CONNECTIONS = 12;
const helloTranscript = (hello: Hello, targetPublicKey: string) => JSON.stringify(['rppl-pair-v1', hello.publicKey, hello.name, hello.nonce, targetPublicKey, hello.expiresAt]);
const replyTranscript = (initial: Hello, reply: Hello) => JSON.stringify(['rppl-pair-reply-v1', initial.publicKey, initial.name, initial.nonce, initial.expiresAt, reply.publicKey, reply.name, reply.nonce]);
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Peer connection failed.';

/** Signaling discovers peers; only pinned device keys or a confirmed invitation authorize data. */
export class PeerSyncTransport {
  private options: PeerSyncTransportOptions;
  private devices = new Map<string, PairedDevice>();
  private peer?: Peer;
  private connections = new Map<string, Connection>();
  private invite?: PairInvite;
  private pendingInviteId?: string;
  private retry?: ReturnType<typeof setInterval>;
  private running = false;
  private blocked = false;
  constructor(options: PeerSyncTransportOptions) {
    this.options = options;
    this.setDevices(options.devices);
  }
  start(): void {
    if (this.running) return;
    this.running = true;
    this.blocked = false;
    this.options.onStatus('Connecting to the pairing service…');
    try {
      this.peer = new Peer(this.options.identity.id, {
        ...this.options.peerOptions,
        config: this.options.peerOptions?.config ?? { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
      });
      this.peer.on('open', () => { this.options.onStatus('Ready. Keep both browser pages open to sync.'); this.reconnect(); });
      this.peer.on('connection', connection => this.acceptConnection(connection));
      this.peer.on('disconnected', () => this.options.onStatus('Pairing service disconnected. Retrying while this page is open.'));
      this.peer.on('error', error => {
        if (error.type === 'unavailable-id') {
          this.blocked = true;
          this.options.onStatus('Sync is already open in another tab of this browser. Close that tab and retry.');
        } else if (error.type === 'peer-unavailable') {
          this.options.onStatus('Waiting for the other browser. Keep both pages open; some networks block direct connections.');
        } else this.options.onStatus(`Sync connection: ${errorText(error)}`);
      });
      this.retry = setInterval(() => this.reconnect(), 10_000);
    } catch (error) { this.options.onStatus(errorText(error)); }
  }
  stop(): void {
    this.running = false;
    if (this.retry) clearInterval(this.retry);
    this.retry = undefined;
    this.invite = undefined;
    this.pendingInviteId = undefined;
    for (const state of [...this.connections.values()]) this.close(state);
    this.peer?.destroy(); this.peer = undefined;
  }
  setDevices(devices: PairedDevice[]): void {
    this.devices = new Map(devices.filter(device => device.id !== this.options.identity.id).map(device => [device.id, device]));
    for (const state of this.connections.values()) {
      if (state.approved && (!this.devices.has(state.connection.peer) || this.devices.get(state.connection.peer)?.publicKey !== state.remote?.publicKey)) this.close(state);
    }
  }
  reconnect(): void {
    if (!this.running || this.blocked || !this.peer || this.peer.destroyed) return;
    if (this.peer.disconnected) { try { this.peer.reconnect(); } catch { /* Next retry can reconnect. */ } return; }
    if (!this.peer.open) return;
    for (const device of this.devices.values()) {
      if (this.options.identity.id < device.id && !this.connections.has(device.id)) this.connect(device.id);
    }
  }
  disconnect(id: string): void { const state = this.connections.get(id); if (state) this.close(state); }
  private async ready(): Promise<void> {
    this.start();
    const deadline = Date.now() + 20_000;
    while (this.running && !this.blocked && !this.peer?.open && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    if (!this.peer?.open || this.blocked || !this.running) throw new Error(this.blocked ? 'Close the other Rolling PPL tab, then retry sync.' : 'Could not reach the pairing service. Check your connection and retry.');
  }
  async createInvite(): Promise<string> {
    await this.ready();
    if (this.pendingInviteId) this.disconnect(this.pendingInviteId);
    const encoded = createInvitation(this.options.identity);
    this.invite = await parseInvitation(encoded);
    this.pendingInviteId = undefined;
    return encoded;
  }
  async joinInvite(input: string): Promise<void> {
    const invite = await parseInvitation(input);
    if (invite.id === this.options.identity.id) throw new Error('Open this invitation in your other browser.');
    await this.ready();
    if (invite.expiresAt <= Date.now()) throw new Error('This invitation has expired. Create a new one.');
    this.disconnect(invite.id);
    this.connect(invite.id, invite);
    this.options.onStatus('Connecting securely. Approve this browser on the device showing the invitation.');
  }
  async approvePair(id: string): Promise<void> {
    const state = this.connections.get(id);
    if (!state || state.closed || !state.requested || !state.authenticated || !state.remote || !state.invite || this.invite !== state.invite || state.invite.expiresAt <= Date.now()) throw new Error('This pairing request has expired. Create a new invitation.');
    this.invite = undefined; this.pendingInviteId = undefined;
    state.approved = true;
    this.remember(state.remote);
    await this.control(state, { kind: 'approved' });
    this.activate(state);
  }
  rejectPair(id: string): void { this.disconnect(id); this.options.onStatus('Pairing declined.'); }
  async send(id: string, bytes: Uint8Array): Promise<void> {
    const state = this.connections.get(id);
    if (!state?.active || state.closed) throw new Error('The paired browser is disconnected.');
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX_MESSAGE_BYTES || state.queuedBytes + bytes.length > MAX_MESSAGE_BYTES * 2) throw new Error('Sync message exceeds the transfer limit.');
    const data = bytes.slice();
    state.queuedBytes += data.length;
    try {
      await this.queue(state, async () => {
        const messageId = randomToken();
        const total = Math.max(1, Math.ceil(data.length / CHUNK_BYTES));
        for (let index = 0; index < total; index++) await this.sealed(state, { kind: 'chunk', id: messageId, index, total, data: encodeBytes(data.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES)) });
      });
    } finally { state.queuedBytes -= data.length; }
  }
  private connect(id: string, invite?: PairInvite): void {
    if (!this.peer?.open || this.connections.has(id) || this.connections.size >= MAX_CONNECTIONS) return;
    const connection = this.peer.connect(id, { reliable: true, serialization: 'raw', label: 'rolling-ppl-sync-v1' });
    this.attach(connection, true, invite);
  }
  private acceptConnection(connection: DataConnection): void {
    if (!this.running || connection.label !== 'rolling-ppl-sync-v1' || this.connections.has(connection.peer) || this.connections.size >= MAX_CONNECTIONS || (!this.devices.has(connection.peer) && (!this.invite || this.invite.expiresAt <= Date.now()))) {
      connection.close(); return;
    }
    this.attach(connection, false);
  }
  private attach(connection: DataConnection, outbound: boolean, invite?: PairInvite): void {
    const state: Connection = {
      connection, outbound, invite, nonce: randomToken(), authenticated: false, approved: false, active: false, closed: false, requested: false,
      incoming: Promise.resolve(), outgoing: Promise.resolve(), queuedBytes: 0, incomingBytes: 0,
      timer: setTimeout(() => { this.options.onStatus('Connection timed out. Keep both pages open and try the same Wi-Fi if this network blocks direct connections.'); this.close(state); }, 30_000),
    };
    this.connections.set(connection.peer, state);
    connection.on('open', () => {
      if (state.outbound) void this.sendHello(state).catch(error => this.fail(state, error));
    });
    connection.on('data', data => {
      if (state.closed) return;
      if (typeof data !== 'string' || data.length > MAX_WIRE_BYTES || state.incomingBytes + data.length > MAX_MESSAGE_BYTES * 2) { this.fail(state, new Error('Invalid or oversized sync frame.')); return; }
      state.incomingBytes += data.length;
      state.incoming = state.incoming.then(async () => { if (!state.closed) await this.receive(state, data); }).catch(error => this.fail(state, error)).finally(() => { state.incomingBytes -= data.length; });
    });
    connection.on('close', () => this.close(state));
    connection.on('error', error => this.fail(state, error));
  }
  private async sendHello(state: Connection): Promise<void> {
    const hello: Hello = { v: 1, type: 'hello', publicKey: this.options.identity.publicKey, name: this.options.name.slice(0, 80), nonce: state.nonce };
    if (state.invite) {
      hello.expiresAt = state.invite.expiresAt;
      hello.proof = await pairingProof(state.invite.secret, helloTranscript(hello, state.invite.publicKey));
    }
    state.localHello = hello;
    await this.raw(state, hello);
  }
  private async receive(state: Connection, data: string): Promise<void> {
    const frame: unknown = JSON.parse(data);
    if (!frame || typeof frame !== 'object' || !('type' in frame) || !('v' in frame) || frame.v !== 1) throw new Error('Unsupported sync protocol.');
    if (frame.type === 'hello') { await this.hello(state, frame as Hello); return; }
    if (frame.type !== 'sealed' || !state.channel) throw new Error('Unauthenticated sync message.');
    const payload = await state.channel.open(frame as SealedFrame);
    if (state.closed) return;
    if (!payload || typeof payload !== 'object' || !('kind' in payload)) throw new Error('Invalid sync message.');
    if (payload.kind === 'auth') {
      if (state.authenticated) throw new Error('Repeated authentication message.');
      state.authenticated = true;
      if (state.invite && !state.approved) {
        clearTimeout(state.timer);
        state.timer = setTimeout(() => { this.options.onStatus('Pairing request expired. Create a new invitation.'); this.close(state); }, Math.max(1, state.invite.expiresAt - Date.now()));
      }
      if (state.invite && !state.outbound && !state.approved) {
        if (!state.remote || state.invite.expiresAt <= Date.now()) throw new Error('Pairing invitation expired.');
        state.requested = true;
        this.options.onPairRequest(state.remote);
      } else this.activate(state);
      return;
    }
    if (payload.kind === 'approved') {
      if (!state.outbound || !state.invite || !state.authenticated || state.approved || !state.remote || state.invite.expiresAt <= Date.now()) throw new Error('Unexpected pairing approval.');
      state.approved = true;
      this.remember(state.remote);
      this.activate(state);
      return;
    }
    if (!state.active || !state.authenticated || !state.approved) throw new Error('Workout data arrived before pairing was approved.');
    if (payload.kind !== 'chunk') throw new Error('Unknown sync message.');
    this.chunk(state, payload);
  }
  private async hello(state: Connection, hello: Hello): Promise<void> {
    if (state.channel || !hello || typeof hello.publicKey !== 'string' || typeof hello.name !== 'string' || hello.name.length > 80 || typeof hello.nonce !== 'string' || decodeBytes(hello.nonce, 32).length !== 32) throw new Error('Invalid device handshake.');
    const id = await deviceId(hello.publicKey);
    if (state.closed) return;
    if (id !== state.connection.peer || id === this.options.identity.id) throw new Error('Device identity does not match the connection.');
    const known = this.devices.get(id);
    if (state.outbound) {
      const expected = state.invite?.publicKey ?? known?.publicKey;
      if (!expected || hello.publicKey !== expected) throw new Error('This is not the paired browser.');
      if (state.invite && (!state.localHello || state.invite.expiresAt <= Date.now() || typeof hello.proof !== 'string' || !await verifyPairingProof(state.invite.secret, replyTranscript(state.localHello, hello), hello.proof))) throw new Error('The invitation could not authenticate this browser.');
    } else if (hello.proof !== undefined) {
      const invite = this.invite;
      if (!invite || invite.expiresAt <= Date.now() || hello.expiresAt !== invite.expiresAt || typeof hello.proof !== 'string' || (this.pendingInviteId && this.pendingInviteId !== id) || !await verifyPairingProof(invite.secret, helloTranscript(hello, this.options.identity.publicKey), hello.proof)) throw new Error('The pairing invitation is invalid or already in use.');
      state.invite = invite;
      this.pendingInviteId = id;
    } else if (!known || known.publicKey !== hello.publicKey) throw new Error('This browser has not been paired.');
    if (state.closed) return;
    state.remote = { id, publicKey: hello.publicKey, name: state.invite ? hello.name : (known?.name ?? hello.name) };
    state.approved = !state.invite;
    if (!state.outbound) {
      const reply: Hello = { v: 1, type: 'hello', publicKey: this.options.identity.publicKey, name: this.options.name.slice(0, 80), nonce: state.nonce };
      if (state.invite) reply.proof = await pairingProof(state.invite.secret, replyTranscript(hello, reply));
      state.localHello = reply;
      await this.raw(state, reply);
    }
    state.channel = await createSecureChannel(this.options.identity, hello.publicKey, state.nonce, hello.nonce);
    if (state.closed) return;
    await this.control(state, { kind: 'auth' });
  }
  private chunk(state: Connection, payload: object): void {
    const frame = payload as Record<string, unknown>;
    if (typeof frame.id !== 'string' || decodeBytes(frame.id, 32).length !== 32 || !Number.isInteger(frame.index) || !Number.isInteger(frame.total) || typeof frame.index !== 'number' || typeof frame.total !== 'number' || frame.total < 1 || frame.total > Math.ceil(MAX_MESSAGE_BYTES / CHUNK_BYTES) || frame.index < 0 || frame.index >= frame.total || typeof frame.data !== 'string') throw new Error('Invalid sync chunk.');
    const bytes = decodeBytes(frame.data, CHUNK_BYTES);
    if (frame.index < frame.total - 1 && bytes.length !== CHUNK_BYTES) throw new Error('Truncated sync chunk.');
    if (!state.assembly) {
      if (frame.index !== 0) throw new Error('Missing beginning of sync message.');
      state.assembly = { id: frame.id, total: frame.total, next: 0, chunks: [], bytes: 0, started: Date.now() };
    }
    const assembly = state.assembly;
    if (assembly.id !== frame.id || assembly.total !== frame.total || assembly.next !== frame.index || assembly.bytes + bytes.length > MAX_MESSAGE_BYTES || Date.now() - assembly.started > 120_000) throw new Error('Invalid or expired sync transfer.');
    assembly.chunks.push(bytes); assembly.bytes += bytes.length; assembly.next++;
    if (assembly.next === assembly.total) {
      const message = new Uint8Array(assembly.bytes);
      let offset = 0;
      for (const chunk of assembly.chunks) { message.set(chunk, offset); offset += chunk.length; }
      state.assembly = undefined;
      this.options.onMessage(state.connection.peer, message);
    }
  }
  private remember(device: PairedDevice): void {
    this.devices.set(device.id, device);
    this.options.onPaired(device);
  }
  private activate(state: Connection): void {
    if (state.closed || state.active || !state.authenticated || !state.approved || !state.remote) return;
    if (this.devices.get(state.remote.id)?.publicKey !== state.remote.publicKey) throw new Error('This browser is no longer paired.');
    state.active = true;
    clearTimeout(state.timer);
    this.options.onStatus('Connected securely. Changes sync while both pages stay open.');
    this.options.onConnected(state.remote.id);
  }
  private queue(state: Connection, operation: () => Promise<void>): Promise<void> {
    const pending = state.outgoing.then(async () => { if (state.closed) throw new Error('The paired browser disconnected.'); await operation(); });
    state.outgoing = pending.catch(error => this.fail(state, error));
    return pending;
  }
  private control(state: Connection, payload: unknown): Promise<void> { return this.queue(state, () => this.sealed(state, payload)); }
  private async sealed(state: Connection, payload: unknown): Promise<void> {
    if (!state.channel) throw new Error('Device authentication has not finished.');
    await this.raw(state, await state.channel.seal(payload));
  }
  private async raw(state: Connection, payload: unknown): Promise<void> {
    const text = JSON.stringify(payload);
    if (text.length > MAX_WIRE_BYTES) throw new Error('Sync frame exceeds the transfer limit.');
    const deadline = Date.now() + 20_000;
    while (!state.closed && state.connection.open && state.connection.dataChannel.bufferedAmount > 256_000 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (state.closed || !state.connection.open) throw new Error('The paired browser disconnected.');
    if (state.connection.dataChannel.bufferedAmount > 256_000) throw new Error('Sync transfer stalled. Keep both pages open and retry.');
    await state.connection.send(text);
  }
  private fail(state: Connection, error: unknown): void {
    if (state.closed) return;
    this.options.onStatus(errorText(error));
    this.close(state);
  }
  private close(state: Connection): void {
    if (state.closed) return;
    state.closed = true;
    const wasActive = state.active;
    state.active = false;
    clearTimeout(state.timer);
    state.assembly = undefined;
    if (this.connections.get(state.connection.peer) === state) this.connections.delete(state.connection.peer);
    if (this.pendingInviteId === state.connection.peer) this.pendingInviteId = undefined;
    state.connection.close();
    if (wasActive) this.options.onDisconnected(state.connection.peer);
  }
}

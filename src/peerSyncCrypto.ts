export type DeviceIdentity = { privateKey: CryptoKey; publicKey: string; id: string };
export type PairInvite = { v: 1; id: string; publicKey: string; secret: string; expiresAt: number };
export type SealedFrame = { v: 1; type: "sealed"; seq: number; data: string };
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export const INVITE_LIFETIME_MS = 5 * 60_000;
export const MAX_SEALED_BYTES = 32_000;
export function encodeBytes(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
export function decodeBytes(value: string, maximum = MAX_SEALED_BYTES): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value.length > Math.ceil(maximum * 4 / 3) || !/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("Invalid encoded sync data.");
  const raw = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  if (raw.length > maximum) throw new Error("Sync data is too large.");
  const bytes = Uint8Array.from(raw, character => character.charCodeAt(0));
  if (encodeBytes(bytes) !== value) throw new Error("Invalid encoded sync data.");
  return bytes;
}
export function randomToken(): string { return encodeBytes(crypto.getRandomValues(new Uint8Array(32))); }
export async function deviceId(publicKey: string): Promise<string> {
  const raw = decodeBytes(publicKey, 65);
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("Invalid device public key.");
  await crypto.subtle.importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  return `rppl-${Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", raw)), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
export async function createIdentity(): Promise<DeviceIdentity> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const publicKey = encodeBytes(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  return { privateKey: pair.privateKey, publicKey, id: await deviceId(publicKey) };
}
export function createInvitation(identity: DeviceIdentity, now = Date.now()): string {
  // The public key already determines the device ID. Packing the key, secret,
  // and expiry avoids repeating JSON/base64 metadata in a dense camera QR.
  const bytes = new Uint8Array(105);
  bytes.set(decodeBytes(identity.publicKey, 65));
  bytes.set(decodeBytes(randomToken(), 32), 65);
  new DataView(bytes.buffer).setBigUint64(97, BigInt(now + INVITE_LIFETIME_MS));
  return `rppl2.${encodeBytes(bytes)}`;
}
export async function parseInvitation(input: string, now = Date.now()): Promise<PairInvite> {
  let encoded = input.trim();
  if (encoded.includes("#")) encoded = new URLSearchParams(encoded.slice(encoded.indexOf("#") + 1)).get("pair") ?? "";
  if (encoded.startsWith("pair=")) encoded = encoded.slice(5);
  let invite: PairInvite;
  if (encoded.startsWith("rppl2.")) {
    const bytes = decodeBytes(encoded.slice(6), 105);
    if (bytes.length !== 105) throw new Error("This is not a valid device invitation.");
    const publicKey = encodeBytes(bytes.subarray(0, 65));
    invite = { v: 1, id: await deviceId(publicKey), publicKey, secret: encodeBytes(bytes.subarray(65, 97)), expiresAt: Number(new DataView(bytes.buffer).getBigUint64(97)) };
  } else {
    // Existing QR codes and pasted links still work during the rollout.
    invite = JSON.parse(decoder.decode(decodeBytes(encoded, 2048))) as PairInvite;
  }
  if (!invite || invite.v !== 1 || typeof invite.id !== "string" || typeof invite.publicKey !== "string" || typeof invite.secret !== "string" || !Number.isSafeInteger(invite.expiresAt)) throw new Error("This is not a valid device invitation.");
  if (invite.expiresAt <= now || invite.expiresAt > now + INVITE_LIFETIME_MS + 30_000) throw new Error("This device invitation has expired. Create a new one.");
  if (decodeBytes(invite.secret, 32).length !== 32 || await deviceId(invite.publicKey) !== invite.id) throw new Error("Invalid device invitation.");
  return invite;
}
export async function pairingProof(secret: string, transcript: string): Promise<string> {
  const raw = decodeBytes(secret, 32);
  if (raw.length !== 32) throw new Error("Invalid pairing secret.");
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return encodeBytes(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(transcript))));
}
export async function verifyPairingProof(secret: string, transcript: string, proof: string): Promise<boolean> {
  try {
    const raw = decodeBytes(secret, 32);
    if (raw.length !== 32) return false;
    const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    return await crypto.subtle.verify("HMAC", key, decodeBytes(proof, 32), encoder.encode(transcript));
  } catch { return false; }
}
/** Directional keys and fresh nonces prevent reflection and cross-connection replay. */
export async function createSecureChannel(identity: DeviceIdentity, remotePublicKey: string, localNonce: string, remoteNonce: string) {
  const remoteId = await deviceId(remotePublicKey);
  if (remoteId === identity.id) throw new Error("A device cannot sync with itself.");
  if (decodeBytes(localNonce, 32).length !== 32 || decodeBytes(remoteNonce, 32).length !== 32) throw new Error("Invalid connection nonce.");
  const remoteKey = await crypto.subtle.importKey("raw", decodeBytes(remotePublicKey, 65), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: remoteKey }, identity.privateKey, 256);
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const nonces = identity.id < remoteId ? [localNonce, remoteNonce] : [remoteNonce, localNonce];
  const salt = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(nonces)));
  const derive = (from: string, to: string) => crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: encoder.encode(`rolling-ppl-sync-v1:${from}:${to}`) }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const [sendKey, receiveKey] = await Promise.all([derive(identity.id, remoteId), derive(remoteId, identity.id)]);
  let sendSequence = 0;
  let receiveSequence = 0;
  let receiving: Promise<unknown> = Promise.resolve();
  const iv = (sequence: number) => {
    const bytes = new Uint8Array(12);
    new DataView(bytes.buffer).setBigUint64(4, BigInt(sequence));
    return bytes;
  };
  const aad = (sequence: number) => encoder.encode(`rolling-ppl-sync-v1:${sequence}`);
  return {
    async seal(payload: unknown): Promise<SealedFrame> {
      const bytes = encoder.encode(JSON.stringify(payload));
      if (bytes.length > MAX_SEALED_BYTES - 16 || !Number.isSafeInteger(sendSequence)) throw new Error("Sync frame is too large.");
      const seq = sendSequence++;
      const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv(seq), additionalData: aad(seq), tagLength: 128 }, sendKey, bytes);
      return { v: 1, type: "sealed", seq, data: encodeBytes(new Uint8Array(encrypted)) };
    },
    open(frame: SealedFrame): Promise<unknown> {
      const pending = receiving.then(async () => {
      if (!frame || frame.v !== 1 || frame.type !== "sealed" || !Number.isSafeInteger(frame.seq) || frame.seq !== receiveSequence) throw new Error("Replayed or out-of-order sync frame.");
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv(frame.seq), additionalData: aad(frame.seq), tagLength: 128 }, receiveKey, decodeBytes(frame.data));
      const result: unknown = JSON.parse(decoder.decode(plain));
      receiveSequence++;
      return result;
      });
      receiving = pending.catch(() => undefined);
      return pending;
    },
  };
}
export type SecureChannel = Awaited<ReturnType<typeof createSecureChannel>>;

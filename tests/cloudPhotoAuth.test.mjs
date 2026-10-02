import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { pkceChallenge, parseCloudPhotoConfig, completeCloudPhotoSignIn, refreshCloudPhotoSession, CLOUD_PHOTO_SESSION_KEY } from "../src/cloudPhotoAuth.ts";
import { cloudPhotoStatus, photoChecksum } from "../src/cloudPhotoBackup.ts";

const config = { region: "eu-central-1", userPoolId: "pool", clientId: "client", authDomain: "https://auth.example.com", apiBaseUrl: "https://api.example.com", redirectUri: "https://app.example.com/" };
function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}
test("PKCE uses RFC7636 S256 and photo checksum is base64 SHA256", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
  try {
    assert.equal(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    assert.equal(await photoChecksum(new Blob(["abc"])), "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=");
  } finally { if (previous) Object.defineProperty(globalThis, "crypto", previous); }
});
test("configuration is public and secure; sign-in rejects missing or mismatched state before token exchange", async () => {
  const previous = new Map(["window", "localStorage", "sessionStorage", "fetch"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let exchanges = 0;
  let callbackUrl = "https://app.example.com/?code=secret&state=wrong#progress";
  const browser = { location: { origin: "https://app.example.com", get href() { return callbackUrl; } }, history: { replaceState: (_a, _b, url) => { callbackUrl = String(url); } } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage() });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage() });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async () => { exchanges++; return new Response("{}"); } });
  try {
    assert.deepEqual(parseCloudPhotoConfig(config), config);
    assert.throws(() => parseCloudPhotoConfig({ ...config, apiBaseUrl: "http://api.example.com" }), /secure/);
    assert.throws(() => parseCloudPhotoConfig({ ...config, redirectUri: "https://other.example.com" }), /another app/);
    await assert.rejects(completeCloudPhotoSignIn(config), /could not be verified/);
    assert.equal(exchanges, 0);
    assert.equal(new URL(callbackUrl).searchParams.has("code"), false);
    assert.equal(new URL(callbackUrl).hash, "#progress");
    callbackUrl = "https://app.example.com/?error=access_denied&state=x";
    await assert.rejects(completeCloudPhotoSignIn(config), /cancelled/);
    assert.equal(localStorage.getItem(CLOUD_PHOTO_SESSION_KEY), null);
    const jwt = (claims) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
    globalThis.fetch = async () => new Response(JSON.stringify({ access_token: jwt({ sub: "account-b", token_use: "access", client_id: "client" }), expires_in: 3600 }));
    await assert.rejects(refreshCloudPhotoSession(config, { accessToken: "old", refreshToken: "refresh", expiresAt: 0, owner: "pool:account-a" }), /account changed/);
    assert.equal(localStorage.getItem(CLOUD_PHOTO_SESSION_KEY), null, "refresh cannot silently switch accounts");
  } finally {
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  }
});
test("photo state never labels a pending upload as backed up or reveals another account identity", () => {
  const state = { owner: "pool:a", enabled: true, signedIn: true };
  assert.equal(cloudPhotoStatus({}, state), "Saved on device");
  assert.match(cloudPhotoStatus({ cloud: { owner: "pool:a", status: "pending" } }, state), /pending/);
  assert.equal(cloudPhotoStatus({ cloud: { owner: "pool:a", status: "backed-up" } }, state), "Backed up");
  assert.match(cloudPhotoStatus({ cloud: { owner: "pool:a", status: "deleted" } }, state), /cloud copy deleted/);
  assert.match(cloudPhotoStatus({ cloud: { owner: "pool:b", status: "backed-up" } }, state), /another account/);
});

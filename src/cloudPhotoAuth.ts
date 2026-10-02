export type CloudPhotoConfig = {
  region: string;
  userPoolId: string;
  clientId: string;
  authDomain: string;
  apiBaseUrl: string;
  redirectUri: string;
};
export type CloudPhotoSession = { accessToken: string; refreshToken?: string; expiresAt: number; owner: string; email?: string };
export const CLOUD_PHOTO_SESSION_KEY = "rolling-ppl:cloud-photo-session";
const AUTH_TRANSACTION_KEY = "rolling-ppl:cloud-photo-sign-in";

export function cloudPhotoFetch(input: RequestInfo | URL, options: RequestInit = {}, timeout = 15_000) {
  return fetch(input, { ...options, signal: AbortSignal.timeout(timeout) });
}
export function storeCloudPhotoSession(session: CloudPhotoSession) {
  localStorage.setItem(CLOUD_PHOTO_SESSION_KEY, JSON.stringify(session));
}

export function parseCloudPhotoConfig(value: unknown): CloudPhotoConfig {
  if (!value || typeof value !== "object") throw new Error("Photo backup is not configured yet.");
  const config = value as CloudPhotoConfig;
  if (![config.region, config.userPoolId, config.clientId, config.authDomain, config.apiBaseUrl, config.redirectUri].every((item) => typeof item === "string" && item.length > 0)) {
    throw new Error("Photo backup is not configured yet.");
  }
  for (const value of [config.authDomain, config.apiBaseUrl, config.redirectUri]) {
    const url = new URL(value);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("Photo backup requires a secure connection.");
    if (url.username || url.password || url.hash) throw new Error("Photo backup configuration is invalid.");
  }
  if (new URL(config.redirectUri).origin !== window.location.origin) throw new Error("Photo backup is configured for another app address.");
  return { ...config, authDomain: config.authDomain.replace(/\/$/, ""), apiBaseUrl: config.apiBaseUrl.replace(/\/$/, "") };
}

function randomUrlToken() {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}
function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export async function pkceChallenge(verifier: string) {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}
function tokenClaims(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) throw new Error("Sign-in returned an invalid session.");
  return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
}

export function readCloudPhotoSession(): CloudPhotoSession | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(CLOUD_PHOTO_SESSION_KEY) ?? "null") as CloudPhotoSession | null;
    if (!value || typeof value.accessToken !== "string" || typeof value.owner !== "string" || !Number.isFinite(value.expiresAt)) return undefined;
    return value;
  } catch { return undefined; }
}
export function clearCloudPhotoSession() { localStorage.removeItem(CLOUD_PHOTO_SESSION_KEY); }

async function exchange(config: CloudPhotoConfig, body: URLSearchParams, previous?: CloudPhotoSession): Promise<CloudPhotoSession> {
  const response = await cloudPhotoFetch(`${config.authDomain}/oauth2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!response.ok) throw new Error("Your sign-in session has expired. Sign in again to continue photo backup.");
  const tokens = await response.json() as { access_token?: string; refresh_token?: string; id_token?: string; expires_in?: number };
  if (!tokens.access_token) throw new Error("Sign-in did not return a photo backup session.");
  // Claims are used for local association and display only. The API verifies the JWT.
  const claims = tokenClaims(tokens.access_token);
  if (typeof claims.sub !== "string" || claims.token_use !== "access" || claims.client_id !== config.clientId) throw new Error("Sign-in returned an invalid session.");
  const identity = tokens.id_token ? tokenClaims(tokens.id_token) : {};
  const session: CloudPhotoSession = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? previous?.refreshToken,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    owner: `${config.userPoolId}:${claims.sub}`,
    email: typeof identity.email === "string" ? identity.email : previous?.email,
  };
  if (previous && session.owner !== previous.owner) throw new Error("The photo backup account changed. Sign in again.");
  if (!previous) storeCloudPhotoSession(session);
  return session;
}

export async function signInCloudPhotos(config: CloudPhotoConfig) {
  const verifier = randomUrlToken();
  const state = randomUrlToken();
  const transaction = { verifier, state, createdAt: Date.now(), redirectUri: config.redirectUri };
  sessionStorage.setItem(AUTH_TRANSACTION_KEY, JSON.stringify(transaction));
  const params = new URLSearchParams({ response_type: "code", client_id: config.clientId, redirect_uri: config.redirectUri, scope: "openid email", state, code_challenge_method: "S256", code_challenge: await pkceChallenge(verifier) });
  window.location.assign(`${config.authDomain}/oauth2/authorize?${params}`);
}

export async function completeCloudPhotoSignIn(config: CloudPhotoConfig): Promise<CloudPhotoSession | undefined> {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("code") && !url.searchParams.has("error")) return readCloudPhotoSession();
  const raw = sessionStorage.getItem(AUTH_TRANSACTION_KEY);
  sessionStorage.removeItem(AUTH_TRANSACTION_KEY);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  for (const key of ["code", "state", "error", "error_description"]) url.searchParams.delete(key);
  window.history.replaceState(null, "", url);
  if (error) throw new Error("Sign-in was cancelled or could not finish. Your photos are still saved on this device.");
  const transaction = raw ? JSON.parse(raw) as { verifier: string; state: string; createdAt: number; redirectUri: string } : undefined;
  if (!transaction || state !== transaction.state || Date.now() - transaction.createdAt > 15 * 60_000 || transaction.redirectUri !== config.redirectUri || !code) {
    throw new Error("Sign-in could not be verified. Start sign-in again; your local photos are safe.");
  }
  return exchange(config, new URLSearchParams({ grant_type: "authorization_code", client_id: config.clientId, code, redirect_uri: config.redirectUri, code_verifier: transaction.verifier }));
}

export async function refreshCloudPhotoSession(config: CloudPhotoConfig, session: CloudPhotoSession) {
  if (session.expiresAt > Date.now() + 60_000) return session;
  if (!session.refreshToken) throw new Error("Sign in again to continue photo backup.");
  return exchange(config, new URLSearchParams({ grant_type: "refresh_token", client_id: config.clientId, refresh_token: session.refreshToken }), session);
}

export async function signOutCloudPhotos(config: CloudPhotoConfig, session = readCloudPhotoSession()) {
  clearCloudPhotoSession();
  if (session?.refreshToken) {
    await cloudPhotoFetch(`${config.authDomain}/oauth2/revoke`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: config.clientId, token: session.refreshToken }) }).catch(() => undefined);
  }
  const params = new URLSearchParams({ client_id: config.clientId, logout_uri: config.redirectUri });
  window.location.assign(`${config.authDomain}/logout?${params}`);
}

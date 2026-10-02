// Isolated Chrome contexts and synthetic pictures. No real account or photos.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const appUrl = process.env.PROGRESS_TEST_URL || "http://127.0.0.1:4187/";
const config = { region: "eu-central-1", userPoolId: "test-pool", clientId: "test-client", authDomain: "https://photo-auth.example.test", apiBaseUrl: "https://photo-api.example.test", redirectUri: appUrl };
const token = (account) => `e30.${Buffer.from(JSON.stringify({ sub: account, client_id: config.clientId, token_use: "access" })).toString("base64url")}.synthetic`;
const session = (account) => ({ accessToken: token(account), refreshToken: `refresh-${account}`, owner: `test-pool:${account}`, email: `${account}@example.test`, expiresAt: Date.now() + 3600_000 });
const accounts = new Map();
const getAccount = (id) => { if (!accounts.has(id)) accounts.set(id, { photos: new Map(), tombstones: new Map(), pending: new Map() }); return accounts.get(id); };
let failUploads = false, signInAccount = "account-a", pkce;
const uploadAttempts = [], apiCalls = [], errors = [], contexts = [];
const browser = await chromium.launch({ channel: "chrome", headless: true });
await mkdir("outputs/cloud-photo-backup", { recursive: true });
function accountFromRequest(request) {
  const authorization = request.headers().authorization;
  assert.ok(authorization?.startsWith("Bearer "), "authenticated API calls use an access token");
  return JSON.parse(Buffer.from(authorization.slice(7).split(".")[1], "base64url")).sub;
}
async function createPage(seedAccount, missingConfig = false) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  contexts.push(context);
  if (seedAccount) await context.addInitScript(({ session }) => {
    if (localStorage.getItem("cloud-test-seeded")) return;
    localStorage.setItem("cloud-test-seeded", "yes");
    localStorage.setItem("rolling-ppl:cloud-photo-session", JSON.stringify(session));
    localStorage.setItem("rolling-ppl:cloud-photo-preferences", JSON.stringify({ enabled: [session.owner], removed: {}, deletions: {} }));
  }, { session: session(seedAccount) });
  await context.route("**/cloud-photo-config.json", (route) => missingConfig ? route.fulfill({ contentType: "text/html", body: "<!doctype html><title>App fallback</title>" }) : route.fulfill({ json: config }));
  await context.route(`${config.authDomain}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/oauth2/authorize") {
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      assert.equal(url.searchParams.get("client_id"), config.clientId);
      pkce = url.searchParams.get("code_challenge");
      const callback = new URL(appUrl);
      callback.searchParams.set("code", "synthetic-code");
      callback.searchParams.set("state", url.searchParams.get("state"));
      return route.fulfill({ status: 302, headers: { location: callback.href } });
    }
    if (url.pathname === "/oauth2/token") {
      const form = new URLSearchParams(route.request().postData());
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(createHash("sha256").update(form.get("code_verifier")).digest("base64url"), pkce);
      return route.fulfill({ json: { access_token: token(signInAccount), refresh_token: `refresh-${signInAccount}`, expires_in: 3600 } });
    }
    return route.fulfill({ status: 200 });
  });
  await context.route(`${config.apiBaseUrl}/**`, async (route) => {
    const request = route.request(), url = new URL(request.url()), accountId = accountFromRequest(request), account = getAccount(accountId);
    apiCalls.push({ account: accountId, path: url.pathname, method: request.method() });
    const [, , id, action] = url.pathname.split("/");
    if (url.pathname === "/photos") return route.fulfill({ json: { photos: [...account.photos.values()].map(({ bytes, ...metadata }) => metadata), tombstones: [...account.tombstones.values()] } });
    if (request.method() === "DELETE") {
      account.photos.delete(id); account.pending.delete(id);
      const tombstone = { id, deletedAt: new Date().toISOString() }; account.tombstones.set(id, tombstone);
      return route.fulfill({ json: tombstone });
    }
    if (account.tombstones.has(id)) return route.fulfill({ status: 409, json: { error: { code: "PHOTO_DELETED", message: "This photo's cloud backup was deleted." } } });
    if (action === "upload") {
      const metadata = { id, ...request.postDataJSON() };
      account.pending.set(id, metadata);
      return route.fulfill({ json: { uploadId: id, url: `https://photo-upload.example.test/${accountId}/${id}`, fields: { key: `${accountId}/${id}` } } });
    }
    if (action === "confirm") {
      const photo = account.pending.get(id); assert.ok(photo.bytes, "confirmation follows successful image transfer");
      account.photos.set(id, photo); account.pending.delete(id);
      const { bytes, ...metadata } = photo;
      return route.fulfill({ json: { photo: metadata } });
    }
    if (action === "download") return route.fulfill({ json: { url: `https://photo-download.example.test/${accountId}/${id}`, photo: account.photos.get(id) } });
    throw new Error(`Unexpected API request ${url}`);
  });
  await context.route("https://photo-upload.example.test/**", async (route) => {
    const [, accountId, id] = new URL(route.request().url()).pathname.split("/");
    uploadAttempts.push({ account: accountId, id });
    if (failUploads) return route.fulfill({ status: 503 });
    const body = route.request().postDataBuffer(), boundary = route.request().headers()["content-type"].split("boundary=")[1];
    const fileHeader = body.indexOf(Buffer.from('name="file"'));
    const start = body.indexOf(Buffer.from("\r\n\r\n"), fileHeader) + 4;
    const end = body.indexOf(Buffer.from(`\r\n--${boundary}`), start);
    const bytes = body.subarray(start, end), pending = getAccount(accountId).pending.get(id);
    assert.equal(createHash("sha256").update(bytes).digest("base64"), pending.checksumSha256);
    assert.equal(bytes.length, pending.size); pending.bytes = bytes;
    return route.fulfill({ status: 204 });
  });
  await context.route("https://photo-download.example.test/**", async (route) => {
    const [, accountId, id] = new URL(route.request().url()).pathname.split("/");
    const photo = getAccount(accountId).photos.get(id);
    return route.fulfill({ body: photo.bytes, contentType: photo.mimeType });
  });
  const page = await context.newPage(); page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(appUrl);
  await page.getByRole("button", { name: "Progress", exact: true }).click();
  await page.getByRole("tab", { name: "Photos", exact: true }).click();
  await page.getByRole("heading", { name: "Progress photos", exact: true }).waitFor();
  return { page, context };
}
async function until(page, predicate, description) {
  await page.waitForFunction(predicate, undefined, { timeout: 30_000 }).catch(() => { throw new Error(`Timed out: ${description}`); });
}
async function worker(page, operation) {
  assert.equal(operation, "syncCloudPhotos");
  // Operate the mounted UI's service instance. An unversioned direct import
  // in a running Vite server can create a second module after an HMR edit.
  await page.getByRole("button", { name: "Retry backup", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".cloud-photo-state")?.textContent === "Enabled"
    && [...document.querySelectorAll(".cloud-photo-actions button")].some((button) => button.textContent === "Retry backup" && !button.disabled));
}
async function records(page) { return page.evaluate(async () => (await (await import("/src/photoStorage.ts")).getProgressPhotos()).map(({ blob, thumbnail, ...photo }) => ({ ...photo, size: blob.size }))); }
async function addPhoto(page, color = "#496b52") {
  const image = await page.evaluate((color) => { const canvas = document.createElement("canvas"); canvas.width = 80; canvas.height = 120; const context = canvas.getContext("2d"); context.fillStyle = color; context.fillRect(0, 0, 80, 120); return canvas.toDataURL("image/png").split(",")[1]; }, color);
  await page.locator('input[type="file"][accept="image/jpeg,image/png,image/webp"]').setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer: Buffer.from(image, "base64") });
}
try {
  const { page } = await createPage();
  await addPhoto(page);
  await page.getByText("Saved on device", { exact: true }).waitFor();
  assert.equal(uploadAttempts.length, 0);
  await page.getByRole("button", { name: "Enable backup & sign in", exact: true }).click();
  await page.getByRole("button", { name: "Back up 1 existing photo", exact: true }).waitFor();
  assert.equal(uploadAttempts.length, 0, "existing photos require explicit account association");
  await page.getByRole("button", { name: "Back up 1 existing photo", exact: true }).click();
  await page.getByText("Backed up", { exact: true }).waitFor();
  const firstId = (await records(page))[0].id;
  failUploads = true;
  await addPhoto(page, "#a99a76");
  await page.getByText(/This photo could not upload/).waitFor();
  const pending = (await records(page)).find((photo) => photo.id !== firstId);
  assert.equal(pending.cloud.status, "pending"); assert.ok(pending.size > 0);
  failUploads = false;
  await page.getByRole("button", { name: "Retry backup", exact: true }).click();
  await until(page, () => document.querySelectorAll(".photo-cloud-status").length === 2 && [...document.querySelectorAll(".photo-cloud-status")].every((node) => node.textContent === "Backed up"), "failed photo retry confirms backup");
  await page.reload();
  await page.getByRole("heading", { name: "Progress photos", exact: true }).waitFor();
  assert.equal((await records(page)).length, 2, "reload keeps photos and account binding");
  await page.evaluate(({ session }) => {
    localStorage.setItem("rolling-ppl:cloud-photo-session", JSON.stringify(session));
    localStorage.setItem("rolling-ppl:cloud-photo-preferences", JSON.stringify({ enabled: [session.owner], removed: {}, deletions: {} }));
    window.dispatchEvent(new StorageEvent("storage", { key: "rolling-ppl:cloud-photo-session" }));
  }, { session: session("account-b") });
  await worker(page, "syncCloudPhotos");
  assert.equal(getAccount("account-b").photos.size, 0, "switching accounts does not upload prior-account photos");
  await addPhoto(page, "#7b6eaa");
  await page.getByText("Backed up", { exact: true }).waitFor();
  assert.equal(getAccount("account-b").photos.size, 1);
  await page.screenshot({ path: "outputs/cloud-photo-backup/account-isolation-mobile.png", fullPage: true });

  // Fresh browser context has no IndexedDB or preferences from the first device.
  const { page: recovery, context: recoveryContext } = await createPage();
  await recovery.getByRole("button", { name: "Enable backup & sign in", exact: true }).click();
  await recovery.getByRole("button", { name: "Recover 2 photos", exact: true }).waitFor();
  assert.equal((await records(recovery)).length, 0);
  await recovery.getByRole("button", { name: "Recover 2 photos", exact: true }).click();
  await until(recovery, () => document.querySelectorAll(".photo-cloud-status").length === 2, "cloud recovery recreates local originals");
  assert.deepEqual((await records(recovery)).map((photo) => photo.id).sort(), [firstId, pending.id].sort());
  await recoveryContext.setOffline(true);
  await recovery.locator(".photo-card").first().getByRole("button", { name: "Delete", exact: true }).click();
  await recovery.getByLabel(/Also delete its cloud backup/).check();
  await recovery.getByRole("button", { name: "Delete photo", exact: true }).click();
  const deletion = await recovery.evaluate(() => JSON.parse(localStorage.getItem("rolling-ppl:cloud-photo-preferences")).deletions["test-pool:account-a"]);
  assert.equal(deletion.length, 1, "offline deletion queues durably");
  await recoveryContext.setOffline(false);
  await worker(recovery, "syncCloudPhotos");
  await recovery.getByText(/1 in your cloud collection/).waitFor();
  assert.ok(getAccount("account-a").tombstones.has(deletion[0]));
  // An unchanged earlier device still has its local copy. Its next sync must
  // honor the cloud tombstone instead of re-uploading that original.
  await page.evaluate(({ session }) => { localStorage.setItem("rolling-ppl:cloud-photo-session", JSON.stringify(session)); localStorage.setItem("rolling-ppl:cloud-photo-preferences", JSON.stringify({ enabled: [session.owner], removed: {}, deletions: {} })); window.dispatchEvent(new StorageEvent("storage", { key: "rolling-ppl:cloud-photo-session" })); }, { session: session("account-a") });
  const uploadsBefore = uploadAttempts.length;
  await worker(page, "syncCloudPhotos");
  assert.equal(uploadAttempts.length, uploadsBefore, "a stale device never resurrects a deleted cloud photo");
  assert.equal((await records(page)).find((photo) => photo.id === deletion[0]).cloud.status, "deleted");
  assert.equal((await records(page)).find((photo) => photo.id === deletion[0]).size > 0, true, "remote deletion preserves a stale device's local original");
  await recovery.screenshot({ path: "outputs/cloud-photo-backup/recovered-mobile.png", fullPage: true });
  assert.equal(await recovery.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  const { page: offlinePage, context: offlineContext } = await createPage("account-c");
  await offlinePage.getByText(/New photos are saved here first/).waitFor();
  await offlineContext.setOffline(true);
  await addPhoto(offlinePage, "#c97665");
  await offlinePage.getByText("Saved on device · backup pending", { exact: true }).waitFor();
  assert.equal(getAccount("account-c").photos.size, 0);
  await offlineContext.setOffline(false);
  await offlinePage.getByText("Backed up", { exact: true }).waitFor();
  assert.equal(getAccount("account-c").photos.size, 1, "online event uploads a photo saved offline automatically");
  failUploads = true;
  await addPhoto(offlinePage, "#6682a5");
  await offlinePage.getByText(/This photo could not upload/).waitFor();
  failUploads = false;
  await offlinePage.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await until(offlinePage, () => document.querySelectorAll(".photo-cloud-status").length === 2 && [...document.querySelectorAll(".photo-cloud-status")].every((node) => node.textContent === "Backed up"), "foreground resume retries a pending upload without reopening the window");
  assert.equal(getAccount("account-c").photos.size, 2);
  const { page: unavailable } = await createPage(undefined, true);
  await unavailable.getByText(/Cloud backup is not available yet/).waitFor();
  assert.equal(await unavailable.locator(".cloud-photo-backup .photo-progress-error").count(), 0, "missing config served as HTML does not expose a parser error");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, uploadAttempts: uploadAttempts.length, authenticatedApiCalls: apiCalls.length, accountACloudPhotos: getAccount("account-a").photos.size, accountBCloudPhotos: getAccount("account-b").photos.size, scenarios: ["PKCE sign-in", "explicit existing-photo association", "new-photo automatic upload", "upload failure and retry", "reload session", "account isolation", "fresh-browser sign-in and recovery", "queued offline deletion", "stale-device tombstone", "offline capture and automatic reconnect upload", "foreground resume retry", "HTML config fallback"], screenshots: "outputs/cloud-photo-backup" }, null, 2));
} finally { await Promise.all(contexts.map((context) => context.close())); await browser.close(); }

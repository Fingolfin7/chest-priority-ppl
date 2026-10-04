// Isolated Chrome contexts and synthetic records against a mocked account API. No real account.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const appUrl = process.env.PROGRESS_TEST_URL || "http://127.0.0.1:4187/";
const config = { region: "eu-central-1", userPoolId: "test-pool", clientId: "test-client", authDomain: "https://records-auth.example.test", apiBaseUrl: "https://records-api.example.test", redirectUri: appUrl };
const token = (account) => `e30.${Buffer.from(JSON.stringify({ sub: account, client_id: config.clientId, token_use: "access" })).toString("base64url")}.synthetic`;
const session = (account) => ({ accessToken: token(account), refreshToken: `refresh-${account}`, owner: `test-pool:${account}`, email: `${account}@example.test`, expiresAt: Date.now() + 3600_000 });
const accounts = new Map();
const getAccount = (id) => { if (!accounts.has(id)) accounts.set(id, new Map()); return accounts.get(id); };
const uploads = [], errors = [], contexts = [];
let pkce;
const browser = await chromium.launch({ channel: "chrome", headless: true });
await mkdir("outputs/cloud-records-backup", { recursive: true });

function accountFromRequest(request) {
  const authorization = request.headers().authorization;
  assert.ok(authorization?.startsWith("Bearer "), "authenticated API calls use an access token");
  return JSON.parse(Buffer.from(authorization.slice(7).split(".")[1], "base64url")).sub;
}
async function createPage(seed) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  contexts.push(context);
  if (seed) await context.addInitScript(({ session, records }) => {
    if (localStorage.getItem("cloud-test-seeded")) return;
    localStorage.setItem("cloud-test-seeded", "yes");
    localStorage.setItem("rolling-ppl:cloud-photo-session", JSON.stringify(session));
    if (records) localStorage.setItem("rolling-ppl:cloud-records-backup", JSON.stringify({ device: "seeded-browser-0001", enabled: [session.owner], last: {} }));
  }, { session: session(seed.account), records: seed.records });
  await context.route("**/cloud-photo-config.json", (route) => route.fulfill({ json: config }));
  await context.route(`${config.authDomain}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/oauth2/authorize") {
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      pkce = url.searchParams.get("code_challenge");
      const callback = new URL(appUrl);
      callback.searchParams.set("code", "synthetic-code");
      callback.searchParams.set("state", url.searchParams.get("state"));
      return route.fulfill({ status: 302, headers: { location: callback.href } });
    }
    if (url.pathname === "/oauth2/token") {
      const form = new URLSearchParams(route.request().postData());
      assert.equal(createHash("sha256").update(form.get("code_verifier")).digest("base64url"), pkce);
      return route.fulfill({ json: { access_token: token("account-a"), refresh_token: "refresh-account-a", expires_in: 3600 } });
    }
    return route.fulfill({ status: 200 });
  });
  await context.route(`${config.apiBaseUrl}/**`, async (route) => {
    const request = route.request(), url = new URL(request.url()), accountId = accountFromRequest(request), account = getAccount(accountId);
    if (url.pathname === "/photos") return route.fulfill({ json: { photos: [], tombstones: [] } });
    const [, , device, action] = url.pathname.split("/");
    if (url.pathname === "/records") return route.fulfill({ json: { devices: [...account.values()].map(({ bytes, ...item }) => item).sort((a, b) => b.savedAt.localeCompare(a.savedAt)) } });
    if (request.method() === "PUT" && device && !action) {
      assert.equal(request.headers()["content-type"], "application/gzip");
      const bytes = request.postDataBuffer(), value = JSON.parse(gunzipSync(bytes).toString("utf8"));
      assert.equal(value.schema, "rolling-ppl-complete-backup"); assert.equal(value.photosIncluded, false); assert.deepEqual(value.photos.photos, []);
      const savedAt = new Date().toISOString();
      const latest = { device, name: url.searchParams.get("name") ?? "", savedAt, size: bytes.length, workouts: value.snapshot.completed.length, foodDays: value.snapshot.nutrition?.days.length ?? 0, weighIns: value.body.weighIns.length };
      account.set(device, { ...latest, bytes, copies: [{ date: savedAt.slice(0, 10), size: bytes.length, savedAt }] });
      uploads.push({ account: accountId, device, meals: value.snapshot.nutrition?.days.reduce((sum, day) => sum + day.meals, 0) ?? 0 });
      return route.fulfill({ json: { latest } });
    }
    if (request.method() === "GET" && action === "download") return route.fulfill({ json: { url: `https://records-download.example.test/${accountId}/${device}`, copy: account.get(device) } });
    throw new Error(`Unexpected API request ${request.method()} ${url}`);
  });
  await context.route("https://records-download.example.test/**", async (route) => {
    const [, accountId, device] = new URL(route.request().url()).pathname.split("/");
    return route.fulfill({ body: getAccount(accountId).get(device).bytes, contentType: "application/gzip" });
  });
  const page = await context.newPage(); page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(appUrl);
  await page.getByRole("button", { name: "Train", exact: true }).waitFor();
  return { page, context };
}
async function openData(page, tab) {
  await page.getByText("More", { exact: true }).click();
  await page.getByLabel("Back up, export, or restore data").click();
  await page.getByRole("button", { name: tab, exact: true }).click();
}
async function addMeals(page, count) {
  await page.getByRole("button", { name: "Food", exact: true }).click();
  for (let index = 0; index < count; index++) await page.getByRole("button", { name: "Add a meal", exact: true }).click();
}
const waitFor = async (check, description) => {
  const deadline = Date.now() + 30_000;
  while (!check()) { if (Date.now() > deadline) throw new Error(`Timed out: ${description}`); await new Promise((resolve) => setTimeout(resolve, 100)); }
};

try {
  // Device A: records exist locally, then backup is switched on through sign-in.
  const { page } = await createPage();
  await addMeals(page, 2);
  await openData(page, "Backup");
  await page.getByRole("button", { name: "Turn on & sign in", exact: true }).click();
  await waitFor(() => uploads.length === 1, "sign-in turns on backup and uploads the existing records");
  assert.deepEqual(uploads[0], { account: "account-a", device: uploads[0].device, meals: 2 });
  await openData(page, "Backup");
  await page.getByText(/Last backed up .* 0 workouts · 1 food day/).waitFor();

  // An unchanged reload does not upload again; a forced backup and a new change do.
  await page.reload();
  await page.getByRole("button", { name: "Train", exact: true }).waitFor();
  await page.waitForTimeout(6_000);
  assert.equal(uploads.length, 1, "unchanged records are not uploaded again");
  await addMeals(page, 1);
  await openData(page, "Backup");
  await page.getByRole("button", { name: "Back up now", exact: true }).click();
  await waitFor(() => uploads.length === 2, "Back up now uploads the latest change");
  assert.equal(uploads[1].meals, 3);
  assert.equal(uploads[1].device, uploads[0].device, "a browser keeps one device ID");
  await page.screenshot({ path: "outputs/cloud-records-backup/backup-on-mobile.png", fullPage: true });
  await page.keyboard.press("Escape");

  // Leaving the app sends a waiting change without the 30 second delay.
  await addMeals(page, 1);
  const started = Date.now();
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { value: true, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await waitFor(() => uploads.length === 3, "hiding the app uploads a pending change");
  assert.ok(Date.now() - started < 10_000);
  assert.equal(uploads[2].meals, 4);

  // A cleared, empty browser that is enabled never uploads an empty copy.
  const { page: empty } = await createPage({ account: "account-a", records: true });
  await openData(empty, "Backup");
  await empty.getByText("Nothing to back up from this browser yet.").waitFor({ timeout: 10_000 });
  assert.equal(uploads.length, 3);

  // Device B: signed in, backup off. Restore from the cloud copy merges into its empty data.
  const { page: restore } = await createPage({ account: "account-a" });
  await openData(restore, "Restore");
  await restore.getByRole("button", { name: "Show cloud copies", exact: true }).click();
  await restore.getByText(/0 workouts · 1 food day · 0 weigh-ins/).waitFor();
  await restore.getByRole("button", { name: "Check this copy", exact: true }).click();
  await restore.getByText(/0 workouts · 1 food days · 0 weigh-ins/).waitFor();
  await restore.screenshot({ path: "outputs/cloud-records-backup/restore-preview-mobile.png", fullPage: true });
  await restore.getByRole("button", { name: "Restore this copy", exact: true }).click();
  await restore.getByText("Cloud copy restored. Existing unrelated records were kept.").waitFor();
  await restore.keyboard.press("Escape");
  await restore.getByRole("button", { name: "Food", exact: true }).click();
  await restore.getByLabel("4 meals", { exact: true }).waitFor();
  assert.equal(uploads.length, 3, "restoring does not upload while this browser's backup is off");
  assert.equal(await restore.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, uploads: uploads.length, scenarios: ["PKCE sign-in enables records backup", "existing records upload", "unchanged reload skips upload", "Back up now", "upload on leaving the app", "empty browser never uploads", "fresh-browser cloud restore"], screenshots: "outputs/cloud-records-backup" }, null, 2));
} finally { await Promise.all(contexts.map((context) => context.close())); await browser.close(); }

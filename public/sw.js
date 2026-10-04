const CACHE_NAME = "rolling-ppl-v42";
// Keep on-demand library images across app upgrades. Never cache unrelated hosts.
const EXERCISE_IMAGE_CACHE = "rolling-ppl-exercise-images-v1";
const EXERCISES = [
  "bench", "incline-press", "chest-press-machine", "lateral-raise", "pushdown", "overhead-db-extension",
  "barbell-row", "lat-pulldown", "pullups", "rear-delt-fly", "barbell-curl", "hammer-curl",
  "back-squat", "deadlift", "leg-press", "split-squat", "leg-curl", "calf-raise", "ab-crunch-machine",
];
const APP_SHELL = [
  "./",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  ...EXERCISES.flatMap((slug) => [`./exercises/${slug}-0.jpg`, `./exercises/${slug}-1.jpg`]),
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: "reload" })));
    const page = await cache.match("./");
    const builtAssets = new Set();
    if (page) {
      const html = await page.clone().text();
      for (const match of html.matchAll(/(?:src|href)="(\.\/assets\/[^"]+)"/g)) builtAssets.add(match[1]);
    }
    // The build manifest adds assets index.html does not reference, such as the
    // Automerge WASM the app needs before it can open offline.
    const manifest = await fetch("./asset-manifest.json", { cache: "reload" });
    if (!manifest.ok) throw new Error("The asset manifest is unavailable.");
    for (const url of await manifest.json()) if (typeof url === "string" && url.startsWith("./assets/")) builtAssets.add(url);
    await cache.addAll([...builtAssets].map((url) => new Request(url, { cache: "reload" })));
    // The first page may fetch configuration before this worker takes control.
    // Cache it on install too, without making optional backup a PWA requirement.
    try {
      const config = await fetch("./cloud-photo-config.json", { cache: "reload", signal: AbortSignal.timeout(5000) });
      if (config.ok) await cache.put("./cloud-photo-config.json", config);
    } catch { /* Training still installs when optional backup is unavailable. */ }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith("rolling-ppl-") && name !== CACHE_NAME && name !== EXERCISE_IMAGE_CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
    // Do not navigate clients inside activation: navigation can wait for this
    // worker to activate, deadlocking the page. The next normal reload uses
    // the current shell, and in-progress workouts are not interrupted.
  })());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin === "https://raw.githubusercontent.com" && /^\/yuhonas\/free-exercise-db\/[a-f0-9]{40}\/exercises\/.+\.jpg$/.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(EXERCISE_IMAGE_CACHE);
      const cached = await cache.match(event.request);
      if (cached) return cached;
      try {
        const response = await fetch(event.request);
        if (response.ok) {
          try { await cache.put(event.request, response.clone()); } catch { /* Storage full: still show the online image. */ }
        }
        return response;
      } catch { return Response.error(); }
    })());
    return;
  }
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    if (new URL(event.request.url).pathname.endsWith("/cloud-photo-config.json")) {
      // Public configuration changes independently of the app bundle. Retain a
      // verified response so offline reopening still knows the backup account.
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(event.request, { signal: AbortSignal.timeout(5000) });
        if (response.ok) await cache.put(event.request, response.clone());
        return response;
      } catch {
        return await cache.match(event.request) ?? Response.error();
      }
    }
    if (event.request.mode === "navigate") {
      try {
        const response = await fetch(event.request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put("./", response.clone());
        }
        return response;
      } catch {
        return await caches.match("./") ?? Response.error();
      }
    }
    const cached = await caches.match(event.request);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(event.request, response.clone());
    }
    return response;
  })());
});

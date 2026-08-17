const CACHE_NAME = "rolling-ppl-v10";
const EXERCISES = [
  "bench", "incline-press", "chest-press-machine", "lateral-raise", "pushdown",
  "barbell-row", "lat-pulldown", "pullups", "rear-delt-fly", "barbell-curl",
  "back-squat", "deadlift", "leg-press", "split-squat", "leg-curl", "calf-raise", "abs",
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
    await cache.addAll(APP_SHELL);
    const page = await cache.match("./");
    if (page) {
      const html = await page.clone().text();
      const builtAssets = [...html.matchAll(/(?:src|href)="(\.\/assets\/[^"]+)"/g)].map((match) => match[1]);
      await cache.addAll(builtAssets);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;
    try {
      const response = await fetch(event.request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(event.request, response.clone());
      }
      return response;
    } catch (error) {
      if (event.request.mode === "navigate") return caches.match("./");
      throw error;
    }
  })());
});

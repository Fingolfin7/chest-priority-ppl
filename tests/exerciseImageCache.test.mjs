import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
const CURRENT_CACHE = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8').match(/CACHE_NAME = "([^"]+)"/)[1];
import vm from 'node:vm';
import { EXERCISE_IMAGE_BASE } from '../src/exerciseLibrary.ts';

function worker() {
  const handlers = {}; const stores = new Map(); let online = true; let requests = 0;
  const caches = {
    async open(name) { if (!stores.has(name)) stores.set(name, new Map()); const store = stores.get(name); return {
      async match(request) { return store.get(typeof request === 'string' ? request : request.url)?.clone(); },
      async put(request, response) { store.set(typeof request === 'string' ? request : request.url, response.clone()); },
    }; },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  vm.runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), {
    self: { location: { origin: 'https://example.com' }, addEventListener(name, callback) { handlers[name] = callback; }, clients: { async claim() {} } },
    caches, URL, Response, Request,
    fetch: async () => { requests++; if (!online) throw new Error('Offline'); return new Response('image data', { status: 200, headers: { 'Content-Type': 'image/jpeg' } }); },
  });
  return { handlers, caches, stores, setOnline(value) { online = value; }, get requests() { return requests; },
    async request(url) { let pending; handlers.fetch({ request: new Request(url), respondWith(value) { pending = value; } }); return pending ? await pending : undefined; },
  };
}

test('external exercise images download once and are served offline; an uncached image fails without blocking training', async () => {
  const sw = worker(); const url = EXERCISE_IMAGE_BASE + 'Dumbbell_Bench_Press/0.jpg';
  assert.equal(await (await sw.request(url)).text(), 'image data');
  assert.equal(sw.requests, 1);
  sw.setOnline(false);
  assert.equal(await (await sw.request(url)).text(), 'image data');
  assert.equal(sw.requests, 1);
  assert.equal((await sw.request(EXERCISE_IMAGE_BASE + 'Dumbbell_Bench_Press/1.jpg')).type, 'error');
  assert.equal(await sw.request('https://unrelated.example.com/image.jpg'), undefined);
  assert.equal(await sw.request('https://raw.githubusercontent.com/another/repo/main/photo.jpg'), undefined);
});

test('app upgrades preserve the image cache and other caches, removing only superseded app assets', async () => {
  const sw = worker();
  await sw.request(EXERCISE_IMAGE_BASE + 'Dumbbell_Bench_Press/0.jpg');
  await sw.caches.open('rolling-ppl-v40'); await sw.caches.open(CURRENT_CACHE); await sw.caches.open('another-app-cache');
  let pending; sw.handlers.activate({ waitUntil(value) { pending = value; } }); await pending;
  assert.deepEqual((await sw.caches.keys()).sort(), ['another-app-cache', 'rolling-ppl-exercise-images-v1', CURRENT_CACHE]);
});

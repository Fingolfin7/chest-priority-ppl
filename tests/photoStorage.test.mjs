import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import {
  deleteProgressPhoto,
  exportProgressPhotos,
  getProgressPhotos,
  importProgressPhotos,
  parseProgressPhotoBackup,
  PHOTO_BACKUP_MAX_IMAGE_BYTES,
  PHOTO_PROGRESS_CHANGE_EVENT,
  saveProgressPhoto,
} from "../src/photoStorage.ts";

const validPhoto = {
  id: "photo_1",
  date: "2026-09-21",
  view: "front",
  mimeType: "image/jpeg",
  data: "/9j/AA==",
};

function backup(photos = [validPhoto]) {
  return { schema: "rolling-ppl-progress-photos", version: 1, photos };
}

test("photo backup parsing validates IDs, labels, MIME signatures, and image limits", () => {
  assert.deepEqual(parseProgressPhotoBackup(backup()).photos[0], validPhoto);
  assert.deepEqual(parseProgressPhotoBackup(JSON.stringify(backup())).photos[0], validPhoto);
  assert.throws(() => parseProgressPhotoBackup(backup([{ ...validPhoto, id: "../private" }])), /invalid.*ID/i);
  assert.throws(() => parseProgressPhotoBackup(backup([validPhoto, validPhoto])), /duplicate ID/i);
  assert.throws(() => parseProgressPhotoBackup(backup([{ ...validPhoto, mimeType: "image/svg+xml" }])), /JPEG, PNG, or WebP/i);
  assert.throws(() => parseProgressPhotoBackup(backup([{ ...validPhoto, data: "iVBORw0KGgo=" }])), /does not match its image type/i);
  assert.throws(() => parseProgressPhotoBackup(backup([{ ...validPhoto, date: "2026-02-30" }])), /invalid date/i);
  assert.throws(() => parseProgressPhotoBackup(backup([{ ...validPhoto, view: "diagonal" }])), /invalid view/i);

  const tooLargeBase64 = "A".repeat(Math.ceil((PHOTO_BACKUP_MAX_IMAGE_BYTES + 1) / 3) * 4);
  assert.throws(() => parseProgressPhotoBackup(backup([{ ...validPhoto, data: tooLargeBase64 }])), /8 MiB image limit/i);
});

test("saving compresses into private IndexedDB, emits change events, and exports restorable photos", async () => {
  const previous = new Map();
  const installedNames = ["indexedDB", "createImageBitmap", "document", "window", "crypto"];
  for (const name of installedNames) previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));

  const databases = new Map();
  const objectStoreNames = [];
  const canvasSizes = [];
  let closedBitmaps = 0;
  const browserWindow = new EventTarget();
  let changeEvents = 0;
  browserWindow.addEventListener(PHOTO_PROGRESS_CHANGE_EVENT, () => { changeEvents += 1; });

  class MemoryStore {
    constructor(database, name, transaction) {
      this.database = database;
      this.name = name;
      this.transaction = transaction;
    }

    createIndex() {}

    getAll() {
      return this.transaction.request(() => [...this.database.stores.get(this.name).values()]);
    }

    getAllKeys() {
      return this.transaction.request(() => [...this.database.stores.get(this.name).keys()]);
    }

    put(value) {
      return this.transaction.request(() => {
        this.database.stores.get(this.name).set(value.id, value);
        return value.id;
      });
    }

    delete(key) {
      return this.transaction.request(() => this.database.stores.get(this.name).delete(key));
    }
  }

  class MemoryTransaction {
    pending = 0;
    completed = false;
    completionQueued = false;
    oncomplete = null;
    onerror = null;
    onabort = null;

    constructor(database) {
      this.database = database;
    }

    objectStore(name) {
      return new MemoryStore(this.database, name, this);
    }

    request(run) {
      this.pending += 1;
      const request = { result: undefined, error: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        try {
          request.result = run();
          request.onsuccess?.({ target: request });
        } catch (error) {
          request.error = error;
          request.onerror?.({ target: request });
        } finally {
          this.pending -= 1;
          this.queueCompletion();
        }
      });
      return request;
    }

    queueCompletion() {
      if (this.pending || this.completed || this.completionQueued) return;
      this.completionQueued = true;
      queueMicrotask(() => {
        this.completionQueued = false;
        if (this.pending || this.completed) return;
        this.completed = true;
        this.oncomplete?.();
      });
    }
  }

  class MemoryDatabase {
    stores = new Map();
    objectStoreNames = { contains: (name) => this.stores.has(name) };

    createObjectStore(name) {
      this.stores.set(name, new Map());
      return new MemoryStore(this, name, { request: (run) => ({ result: run() }) });
    }

    transaction(name) {
      if (!this.stores.has(name)) throw new Error(`Missing object store ${name}`);
      return new MemoryTransaction(this);
    }

    close() {}
  }

  const indexedDB = {
    open(name, version) {
      objectStoreNames.push(name);
      const request = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      setTimeout(() => {
        let database = databases.get(name);
        const isNew = !database;
        if (isNew) {
          database = new MemoryDatabase();
          databases.set(name, database);
        }
        request.result = database;
        if (isNew) request.onupgradeneeded?.({ oldVersion: 0, newVersion: version, target: request });
        request.onsuccess?.({ target: request });
      }, 0);
      return request;
    },
  };

  Object.defineProperty(globalThis, "indexedDB", { configurable: true, writable: true, value: indexedDB });
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    writable: true,
    value: async () => ({ width: 4000, height: 3000, close: () => { closedBitmaps += 1; } }),
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: {
      createElement(name) {
        assert.equal(name, "canvas");
        const canvas = {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage() {} }),
          toBlob(callback, mimeType, quality) {
            canvasSizes.push({ width: this.width, height: this.height, mimeType, quality });
            callback(new Blob([Uint8Array.of(0xff, 0xd8, 0xff, 0x00)], { type: mimeType }));
          },
        };
        return canvas;
      },
    },
  });
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: browserWindow });
  Object.defineProperty(globalThis, "crypto", { configurable: true, writable: true, value: webcrypto });

  try {
    const saved = await saveProgressPhoto({ blob: new Blob(["source"], { type: "image/png" }), date: "2026-09-21", view: "front" });
    assert.match(saved.id, /^[0-9a-f-]{36}$/i);
    assert.equal(saved.mimeType, "image/jpeg");
    assert.equal(saved.width, 4000);
    assert.equal(saved.height, 3000);
    assert.equal(saved.blob.size, 4);
    assert.equal(saved.thumbnail.size, 4);
    assert.deepEqual(canvasSizes.map(({ width, height }) => [width, height]), [[1920, 1440], [360, 270]]);
    assert.equal(closedBitmaps, 1);
    assert.deepEqual(objectStoreNames, ["rolling-ppl-progress-photos"]);
    assert.equal(changeEvents, 1);

    const photos = await getProgressPhotos();
    assert.equal(photos.length, 1);
    assert.equal(photos[0].id, saved.id);
    const exported = await exportProgressPhotos();
    assert.equal(exported.photos.length, 1);
    assert.equal(exported.photos[0].data, "/9j/AA==");
    assert.equal((await exportProgressPhotos({ view: "side" })).photos.length, 0);
    await assert.rejects(exportProgressPhotos({ fromDate: "2026-09-23", throughDate: "2026-09-22" }), /start date must be before the end date/i);

    const restored = { ...validPhoto, id: "restored_2", date: "2026-09-22", view: "side" };
    assert.equal(await importProgressPhotos(backup([restored])), 1);
    assert.equal(changeEvents, 2);
    assert.equal((await getProgressPhotos()).length, 2);
    const sideRange = await exportProgressPhotos({ view: "side", fromDate: "2026-09-22", throughDate: "2026-09-22" });
    assert.deepEqual(sideRange.photos.map((photo) => photo.id), [restored.id]);

    const duplicate = { ...restored, date: "2026-09-23" };
    assert.equal(await importProgressPhotos(backup([duplicate])), 1);
    assert.equal(changeEvents, 3);
    assert.equal((await getProgressPhotos()).find((photo) => photo.id === restored.id)?.date, restored.date);

    await deleteProgressPhoto(saved.id);
    assert.equal(changeEvents, 4);
    assert.deepEqual((await getProgressPhotos()).map((photo) => photo.id), [restored.id]);
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

test("save rejects unsupported MIME types and overlarge inputs before decoding", async () => {
  const fakeImage = { size: 10, type: "image/gif" };
  await assert.rejects(saveProgressPhoto({ blob: fakeImage, date: "2026-09-21", view: "front" }), /JPEG, PNG, or WebP/i);
  const oversized = { size: 40 * 1024 * 1024 + 1, type: "image/jpeg" };
  await assert.rejects(saveProgressPhoto({ blob: oversized, date: "2026-09-21", view: "front" }), /smaller than 40 MiB/i);
});

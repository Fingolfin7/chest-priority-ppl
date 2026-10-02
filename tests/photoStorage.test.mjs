import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { getCloudPhotoBackupState, initializeCloudPhotoBackup, photoChecksum, recoverCloudPhotos, removePhotoWithCloudChoice, syncCloudPhotos } from "../src/cloudPhotoBackup.ts";
import {
  deleteProgressPhoto,
  configurePhotoCloudOwner,
  exportProgressPhotos,
  getProgressPhotos,
  importProgressPhotos,
  parseProgressPhotoBackup,
  PHOTO_BACKUP_MAX_IMAGE_BYTES,
  PHOTO_PROGRESS_CHANGE_EVENT,
  saveProgressPhoto,
  restoreCloudProgressPhoto,
  updateProgressPhotoCloud,
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
  const installedNames = ["indexedDB", "createImageBitmap", "document", "window", "crypto", "localStorage", "sessionStorage", "fetch", "navigator"];
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

    get(key) {
      return this.transaction.request(() => this.database.stores.get(this.name).get(key));
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
      addEventListener() {},
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

    // Existing v1 records stay unassociated. Cloud bookkeeping preserves originals.
    const priorRecord = (await getProgressPhotos())[0];
    assert.equal(priorRecord.cloud, undefined);
    await updateProgressPhotoCloud(restored.id, { owner: "pool:account-a", status: "pending" });
    const associated = (await getProgressPhotos())[0];
    assert.equal(associated.blob, priorRecord.blob);
    assert.equal(associated.thumbnail, priorRecord.thumbnail);
    assert.deepEqual(associated.cloud, { owner: "pool:account-a", status: "pending" });
    const localBackup = await exportProgressPhotos();
    assert.equal("cloud" in localBackup.photos[0], false, "portable photo backup does not carry account bindings");
    configurePhotoCloudOwner(() => "pool:account-b");
    await importProgressPhotos(localBackup);
    assert.equal((await getProgressPhotos())[0].cloud.owner, "pool:account-a", "import keeps the existing account association");
    const imported = { ...validPhoto, id: "account_b_import" };
    await importProgressPhotos(backup([imported]));
    assert.equal((await getProgressPhotos()).find((photo) => photo.id === imported.id).cloud.owner, "pool:account-b");

    let owner = "pool:account-a";
    configurePhotoCloudOwner(() => owner);
    const saving = saveProgressPhoto({ blob: new Blob(["image"], { type: "image/jpeg" }), date: "2026-09-23", view: "back" });
    owner = "pool:account-b";
    assert.equal((await saving).cloud.owner, "pool:account-a", "account captured before asynchronous image processing");
    await restoreCloudProgressPhoto({ ...associated, date: "2026-09-24", cloud: { owner: "pool:account-b", status: "backed-up" } });
    assert.equal((await getProgressPhotos()).find((photo) => photo.id === restored.id).cloud.owner, "pool:account-a", "recovery does not overwrite an existing local photo or owner");

    // Exercise the actual worker against a deterministic backend, including
    // failure before confirm, durable tombstones, and recovery verification.
    const account = "pool:account-a";
    const pendingPhoto = (await getProgressPhotos()).find((photo) => photo.cloud?.owner === account && photo.id !== restored.id);
    const memoryStorage = () => {
      const values = new Map();
      return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
    };
    const localStorage = memoryStorage();
    localStorage.setItem("rolling-ppl:cloud-photo-session", JSON.stringify({ accessToken: "access-account-a", owner: account, expiresAt: Date.now() + 3600_000 }));
    localStorage.setItem("rolling-ppl:cloud-photo-preferences", JSON.stringify({ enabled: [account], removed: {}, deletions: {} }));
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: memoryStorage() });
    const network = { onLine: true };
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: network });
    browserWindow.location = { href: "https://app.example.com/", origin: "https://app.example.com" };
    browserWindow.history = { replaceState() {} };
    const restoredBlob = new Blob([Uint8Array.of(0xff, 0xd8, 0xff, 0x00)], { type: "image/jpeg" });
    const cloudRecord = { id: "cloud_only", date: "2026-09-25", view: "front", mimeType: "image/jpeg", size: restoredBlob.size, checksumSha256: await photoChecksum(restoredBlob), width: 4000, height: 3000, createdAt: "2026-09-25T12:00:00.000Z" };
    const remotePhotos = new Map([[cloudRecord.id, cloudRecord]]);
    const tombstones = [{ id: restored.id, deletedAt: "2026-09-24T12:00:00.000Z" }];
    const preparations = [];
    let uploadFails = true;
    let confirmations = 0;
    const json = (value) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input, options = {}) => {
      const url = String(input);
      if (url === "/cloud-photo-config.json") return json({ region: "eu-central-1", userPoolId: "pool", clientId: "client", authDomain: "https://auth.example.com", apiBaseUrl: "https://api.example.com", redirectUri: "https://app.example.com/" });
      if (url === "https://api.example.com/photos") return json({ photos: [...remotePhotos.values()], tombstones });
      if (url.endsWith("/upload")) {
        const id = url.split("/").at(-2);
        const metadata = { id, ...JSON.parse(options.body) };
        preparations.push(id);
        remotePhotos.set(id, metadata);
        return json({ uploadId: "intent", url: "https://upload.example.com", fields: { key: "private" } });
      }
      if (url === "https://upload.example.com") return new Response(null, { status: uploadFails ? 503 : 204 });
      if (url.endsWith("/confirm")) { confirmations++; return json({ photo: remotePhotos.get(url.split("/").at(-2)) }); }
      if (url.endsWith("/download")) return json({ url: "https://download.example.com", photo: cloudRecord });
      if (url === "https://download.example.com") return new Response(restoredBlob);
      if (options.method === "DELETE") {
        const id = url.split("/").at(-1);
        remotePhotos.delete(id);
        tombstones.push({ id, deletedAt: "2026-09-26T12:00:00.000Z" });
        return json(tombstones.at(-1));
      }
      throw new Error(`Unexpected cloud request: ${url}`);
    } });
    await initializeCloudPhotoBackup();
    assert.match(getCloudPhotoBackupState().error, /could not upload/);
    assert.equal(confirmations, 0, "failed object upload never confirms or claims success");
    assert.equal((await getProgressPhotos()).find((photo) => photo.id === pendingPhoto.id).cloud.status, "pending");
    assert.equal((await getProgressPhotos()).find((photo) => photo.id === pendingPhoto.id).blob, pendingPhoto.blob, "upload failure keeps the local original");
    assert.equal((await getProgressPhotos()).find((photo) => photo.id === restored.id).cloud.status, "deleted", "remote tombstone suppresses stale browser upload");
    // A pending S3 object does not appear in the backend's active manifest.
    remotePhotos.delete(pendingPhoto.id);
    uploadFails = false;
    await syncCloudPhotos();
    assert.equal(confirmations, 1);
    assert.deepEqual([...new Set(preparations)], [pendingPhoto.id], "another account's photos and tombstoned photos never upload");
    assert.equal((await getProgressPhotos()).find((photo) => photo.id === pendingPhoto.id).cloud.status, "backed-up");
    assert.equal(getCloudPhotoBackupState().recoverableCount, 1);
    await recoverCloudPhotos();
    const recovered = (await getProgressPhotos()).find((photo) => photo.id === cloudRecord.id);
    assert.equal(await photoChecksum(recovered.blob), cloudRecord.checksumSha256);
    assert.equal(recovered.cloud.owner, account);
    assert.equal(recovered.cloud.checksumSha256, cloudRecord.checksumSha256, "recovery records its verified checksum");
    assert.equal((await getProgressPhotos()).find((photo) => photo.id === pendingPhoto.id).cloud.checksumSha256, await photoChecksum(pendingPhoto.blob));
    const originalArrayBuffer = Blob.prototype.arrayBuffer;
    let originalReads = 0;
    Blob.prototype.arrayBuffer = function () { originalReads++; return originalArrayBuffer.call(this); };
    try { await syncCloudPhotos(); } finally { Blob.prototype.arrayBuffer = originalArrayBuffer; }
    assert.equal(originalReads, 0, "routine reconciliation does not rehash confirmed immutable originals");
    network.onLine = false;
    await removePhotoWithCloudChoice(recovered, true);
    assert.equal((await getProgressPhotos()).some((photo) => photo.id === recovered.id), false);
    assert.deepEqual(JSON.parse(localStorage.getItem("rolling-ppl:cloud-photo-preferences")).deletions[account], [recovered.id], "offline cloud deletion is persisted before local removal");
    network.onLine = true;
    await syncCloudPhotos();
    assert.equal(remotePhotos.has(recovered.id), false);
    assert.deepEqual(JSON.parse(localStorage.getItem("rolling-ppl:cloud-photo-preferences")).deletions[account], []);
    assert.equal(getCloudPhotoBackupState().deletionCount, 0);
  } finally {
    configurePhotoCloudOwner(() => undefined);
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

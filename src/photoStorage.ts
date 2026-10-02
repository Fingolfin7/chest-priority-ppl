export type ProgressPhotoView = "front" | "side" | "back";

export type ProgressPhoto = {
  id: string;
  date: string;
  view: ProgressPhotoView;
  mimeType: PhotoBackupEntry["mimeType"];
  blob: Blob;
  thumbnail: Blob;
  width: number;
  height: number;
  createdAt: string;
  cloud?: { owner: string; status: "pending" | "backed-up" | "deleted"; checksumSha256?: string };
};

// The backup service supplies an account only after the user enables backup.
// Capture the association when a save starts, so changing accounts mid-save
// cannot move a private photo to the next account.
let newPhotoCloudOwner: () => string | undefined = () => undefined;
export function configurePhotoCloudOwner(provider: () => string | undefined) {
  newPhotoCloudOwner = provider;
}

export type PhotoBackupEntry = {
  id: string;
  date: string;
  view: ProgressPhotoView;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  data: string;
};

export type PhotoProgressBackup = {
  schema: "rolling-ppl-progress-photos";
  version: 1;
  photos: PhotoBackupEntry[];
};

export const PHOTO_BACKUP_MAX_PHOTOS = 1_000;
export const PHOTO_BACKUP_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const PHOTO_BACKUP_MAX_BYTES = 256 * 1024 * 1024;
export const PHOTO_PROGRESS_CHANGE_EVENT = "rolling-ppl:photo-progress-change";

const DB_NAME = "rolling-ppl-progress-photos";
const DB_VERSION = 1;
const STORE_NAME = "photos";
const MAX_IMAGE_DIMENSION = 1920;
const THUMBNAIL_DIMENSION = 360;
const MAX_INPUT_IMAGE_BYTES = 40 * 1024 * 1024;
const MAX_DECODED_IMAGE_PIXELS = 100_000_000;
const PHOTO_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
const BACKUP_HEADER = JSON.stringify({ schema: "rolling-ppl-progress-photos", version: 1, photos: [] });

export class PhotoStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PhotoStorageError";
  }
}

export function isProgressPhotoView(value: unknown): value is ProgressPhotoView {
  return value === "front" || value === "side" || value === "back";
}

function formatStorageError(error: unknown, fallback: string) {
  if (error instanceof DOMException && error.name === "QuotaExceededError") {
    return "This device is low on storage. Free up space in the app or browser, then try again.";
  }
  if (error instanceof DOMException && error.name === "SecurityError") {
    return "The browser blocked private photo storage for this site.";
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

function openPhotoDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new PhotoStorageError("This browser does not support private photo storage."));
  }
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    let settled = false;
    const fail = (error: PhotoStorageError) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(new PhotoStorageError(formatStorageError(error, "Could not open private photo storage."), { cause: error }));
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("date", "date", { unique: false });
        store.createIndex("view", "view", { unique: false });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => fail(new PhotoStorageError(formatStorageError(request.error, "Could not open private photo storage."), { cause: request.error }));
    request.onblocked = () => fail(new PhotoStorageError("Private photo storage is busy in another tab. Close the other tab and try again."));
  });
}

function transactionPromise<T>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore, transaction: IDBTransaction) => IDBRequest<T> | void,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    let result: T | undefined;
    try {
      transaction = database.transaction(STORE_NAME, mode);
      const request = work(transaction.objectStore(STORE_NAME), transaction);
      if (request) {
        request.onsuccess = () => { result = request.result; };
        request.onerror = () => reject(new PhotoStorageError(formatStorageError(request.error, "Could not read private photo storage."), { cause: request.error }));
      }
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(new PhotoStorageError(formatStorageError(transaction.error, "Could not save private photo storage."), { cause: transaction.error }));
      transaction.onabort = () => reject(new PhotoStorageError(formatStorageError(transaction.error, "The private photo storage operation was cancelled."), { cause: transaction.error }));
    } catch (error) {
      reject(new PhotoStorageError(formatStorageError(error, "Could not use private photo storage."), { cause: error }));
    }
  });
}

function getAllFromDatabase(database: IDBDatabase): Promise<ProgressPhoto[]> {
  return transactionPromise<ProgressPhoto[]>(database, "readonly", (store) => store.getAll())
    .then((records) => records ?? []);
}

export async function getProgressPhotos(): Promise<ProgressPhoto[]> {
  const database = await openPhotoDatabase();
  try {
    return (await getAllFromDatabase(database)).sort((left, right) => left.date.localeCompare(right.date) || left.createdAt.localeCompare(right.createdAt));
  } finally {
    database.close();
  }
}

export async function saveProgressPhoto(input: {
  blob: Blob;
  date: string;
  view: ProgressPhotoView;
}): Promise<ProgressPhoto> {
  const owner = newPhotoCloudOwner();
  if (!isValidDate(input.date)) throw new PhotoStorageError("Choose a valid photo date.");
  if (!isProgressPhotoView(input.view)) throw new PhotoStorageError("Choose front, side, or back view.");
  if (input.blob.size > MAX_INPUT_IMAGE_BYTES) throw new PhotoStorageError("Choose an image smaller than 40 MiB.");
  if (!PHOTO_MIME_TYPES.includes(input.blob.type as PhotoBackupEntry["mimeType"])) {
    throw new PhotoStorageError("Choose a JPEG, PNG, or WebP image.");
  }
  const variants = await createPhotoVariants(input.blob);
  if (variants.photo.size > PHOTO_BACKUP_MAX_IMAGE_BYTES) {
    throw new PhotoStorageError("The compressed photo is still too large. Try a smaller image.");
  }
  const record: ProgressPhoto = {
    id: crypto.randomUUID(),
    date: input.date,
    view: input.view,
    mimeType: "image/jpeg",
    blob: variants.photo,
    thumbnail: variants.thumbnail,
    width: variants.width,
    height: variants.height,
    createdAt: new Date().toISOString(),
    ...(owner ? { cloud: { owner, status: "pending" as const } } : {}),
  };
  await putPhotoRecords([record]);
  dispatchPhotoChange();
  return record;
}

export async function deleteProgressPhoto(id: string): Promise<void> {
  const database = await openPhotoDatabase();
  try {
    await transactionPromise(database, "readwrite", (store) => store.delete(id));
  } finally {
    database.close();
  }
  dispatchPhotoChange();
}

async function putPhotoRecords(records: ProgressPhoto[]) {
  const database = await openPhotoDatabase();
  try {
    await transactionPromise(database, "readwrite", (store) => {
      for (const record of records) store.put(record);
    });
  } finally {
    database.close();
  }
}

/** Update cloud bookkeeping without replacing or deleting the local image. */
export async function updateProgressPhotoCloud(id: string, cloud: ProgressPhoto["cloud"]): Promise<void> {
  const database = await openPhotoDatabase();
  try {
    await transactionPromise(database, "readwrite", (store) => {
      const request = store.get(id);
      request.onsuccess = () => {
        const photo = request.result as ProgressPhoto | undefined;
        if (photo) store.put({ ...photo, cloud });
      };
    });
  } finally {
    database.close();
  }
  dispatchPhotoChange();
}

/** Restore a verified cloud original by ID; preserve any existing local record. */
export async function restoreCloudProgressPhoto(input: Omit<ProgressPhoto, "thumbnail" | "width" | "height">): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.id) || !isValidDate(input.date) || !isProgressPhotoView(input.view)) {
    throw new PhotoStorageError("The cloud photo has invalid details.");
  }
  if (!PHOTO_MIME_TYPES.includes(input.mimeType) || input.blob.size > PHOTO_BACKUP_MAX_IMAGE_BYTES || input.blob.type !== input.mimeType) {
    throw new PhotoStorageError("The cloud photo has an unsupported image.");
  }
  const thumbnail = await createThumbnail(input.blob);
  await mergePhotoRecords([{ ...input, thumbnail: thumbnail.blob, width: thumbnail.width, height: thumbnail.height }]);
  dispatchPhotoChange();
}

async function mergePhotoRecords(records: ProgressPhoto[]) {
  if (!records.length) return;
  const database = await openPhotoDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const keysRequest = store.getAllKeys();
        keysRequest.onsuccess = () => {
          const existing = new Set(keysRequest.result.map(String));
          for (const record of records) {
            if (!existing.has(record.id)) store.put(record);
          }
        };
        keysRequest.onerror = () => reject(new PhotoStorageError(formatStorageError(keysRequest.error, "Could not merge photo backup."), { cause: keysRequest.error }));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(new PhotoStorageError(formatStorageError(transaction.error, "Could not merge photo backup."), { cause: transaction.error }));
        transaction.onabort = () => reject(new PhotoStorageError(formatStorageError(transaction.error, "Photo backup import was cancelled."), { cause: transaction.error }));
      } catch (error) {
        reject(new PhotoStorageError(formatStorageError(error, "Could not merge photo backup."), { cause: error }));
      }
    });
  } finally {
    database.close();
  }
}

export async function getProgressPhotoStorageInfo(): Promise<{ usage?: number; quota?: number; persisted: boolean }> {
  const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
  if (!storage) return { persisted: false };
  const [estimate, persisted] = await Promise.all([
    storage.estimate?.().catch(() => undefined),
    storage.persisted?.().catch(() => false),
  ]);
  return { usage: estimate?.usage, quota: estimate?.quota, persisted: persisted ?? false };
}

export async function requestProgressPhotoPersistence(): Promise<boolean> {
  const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
  if (!storage?.persist) return false;
  return storage.persist();
}

/** Returns a validated plain object suitable for embedding in the app's JSON backup. */
export function parseProgressPhotoBackup(value: unknown): PhotoProgressBackup {
  let source = value;
  if (typeof source === "string") {
    if (source.length > PHOTO_BACKUP_MAX_BYTES) throw new PhotoStorageError("Photo backup exceeds the 256 MiB limit.");
    try {
      source = JSON.parse(source) as unknown;
    } catch (error) {
      throw new PhotoStorageError("Photo backup is not valid JSON.", { cause: error });
    }
  }
  if (!isRecord(source) || source.schema !== "rolling-ppl-progress-photos" || source.version !== 1 || !Array.isArray(source.photos)) {
    throw new PhotoStorageError("This is not a supported progress photo backup.");
  }
  if (source.photos.length > PHOTO_BACKUP_MAX_PHOTOS) {
    throw new PhotoStorageError(`Photo backup has more than ${PHOTO_BACKUP_MAX_PHOTOS} photos.`);
  }

  const photos: PhotoBackupEntry[] = [];
  const ids = new Set<string>();
  let projectedBytes = BACKUP_HEADER.length;
  for (const [index, item] of source.photos.entries()) {
    if (!isRecord(item)) throw new PhotoStorageError(`Photo ${index + 1} is invalid.`);
    const { id, date, view, mimeType, data } = item;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || ids.has(id)) {
      throw new PhotoStorageError(`Photo ${index + 1} has a missing, invalid, or duplicate ID.`);
    }
    if (typeof date !== "string" || !isValidDate(date)) throw new PhotoStorageError(`Photo ${index + 1} has an invalid date.`);
    if (!isProgressPhotoView(view)) throw new PhotoStorageError(`Photo ${index + 1} has an invalid view label.`);
    if (typeof mimeType !== "string" || !PHOTO_MIME_TYPES.includes(mimeType as PhotoBackupEntry["mimeType"])) {
      throw new PhotoStorageError(`Photo ${index + 1} must be a JPEG, PNG, or WebP image.`);
    }
    if (typeof data !== "string" || !data.length || data.length % 4 !== 0) {
      throw new PhotoStorageError(`Photo ${index + 1} has invalid image data.`);
    }
    const decodedBytes = base64ByteLength(data);
    if (decodedBytes === 0 || decodedBytes > PHOTO_BACKUP_MAX_IMAGE_BYTES) {
      throw new PhotoStorageError(`Photo ${index + 1} exceeds the 8 MiB image limit.`);
    }
    if (!isBase64(data)) throw new PhotoStorageError(`Photo ${index + 1} has invalid image data.`);
    if (!base64HasMimeSignature(data, mimeType)) throw new PhotoStorageError(`Photo ${index + 1} data does not match its image type.`);
    if (!hasOnlyKeys(item, ["id", "date", "view", "mimeType", "data"])) throw new PhotoStorageError(`Photo ${index + 1} contains unsupported fields.`);
    const entry: PhotoBackupEntry = { id, date, view, mimeType: mimeType as PhotoBackupEntry["mimeType"], data };
    // Since IDs and the remaining labels are restricted to simple ASCII, this is the exact JSON size.
    projectedBytes += JSON.stringify({ ...entry, data: "" }).length + data.length + (photos.length ? 1 : 0);
    if (projectedBytes > PHOTO_BACKUP_MAX_BYTES) throw new PhotoStorageError("Photo backup exceeds the 256 MiB limit.");
    ids.add(id);
    photos.push(entry);
  }
  if (!hasOnlyKeys(source, ["schema", "version", "photos"])) throw new PhotoStorageError("Photo backup contains unsupported fields.");
  return { schema: "rolling-ppl-progress-photos", version: 1, photos };
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export async function exportProgressPhotos(options: {
  view?: ProgressPhotoView;
  fromDate?: string;
  throughDate?: string;
} = {}): Promise<PhotoProgressBackup> {
  if (options.view !== undefined && !isProgressPhotoView(options.view)) throw new PhotoStorageError("Choose front, side, or back view.");
  if (options.fromDate && !isValidDate(options.fromDate)) throw new PhotoStorageError("Choose a valid start date.");
  if (options.throughDate && !isValidDate(options.throughDate)) throw new PhotoStorageError("Choose a valid end date.");
  if (options.fromDate && options.throughDate && options.fromDate > options.throughDate) {
    throw new PhotoStorageError("The start date must be before the end date.");
  }
  const photos = (await getProgressPhotos()).filter((photo) =>
    (!options.view || photo.view === options.view)
      && (!options.fromDate || photo.date >= options.fromDate)
      && (!options.throughDate || photo.date <= options.throughDate),
  );
  if (photos.length > PHOTO_BACKUP_MAX_PHOTOS) {
    throw new PhotoStorageError(`This selection has more than ${PHOTO_BACKUP_MAX_PHOTOS} photos. Choose one view or a shorter date range, then export another file.`);
  }
  const backupPhotos: PhotoBackupEntry[] = [];
  let projectedBytes = BACKUP_HEADER.length;
  for (const [index, photo] of photos.entries()) {
    if (photo.blob.size > PHOTO_BACKUP_MAX_IMAGE_BYTES) {
      throw new PhotoStorageError(`The photo from ${photo.date} is too large for a photo backup. Download it from its preview, or choose another view or date range.`);
    }
    const data = await blobToBase64(photo.blob);
    const entry: PhotoBackupEntry = { id: photo.id, date: photo.date, view: photo.view, mimeType: photo.mimeType, data };
    projectedBytes += JSON.stringify({ ...entry, data: "" }).length + data.length + (index ? 1 : 0);
    if (projectedBytes > PHOTO_BACKUP_MAX_BYTES) {
      throw new PhotoStorageError("This selection is too large for one photo backup. Choose one view or a shorter date range, then export another file.");
    }
    backupPhotos.push(entry);
  }
  return parseProgressPhotoBackup({ schema: "rolling-ppl-progress-photos", version: 1, photos: backupPhotos });
}

/** Validates every entry and prepares all thumbnails before one atomic merge by ID. */
export async function importProgressPhotos(value: unknown): Promise<number> {
  const owner = newPhotoCloudOwner();
  const backup = parseProgressPhotoBackup(value);
  const records: ProgressPhoto[] = [];
  for (const entry of backup.photos) {
    const original = base64ToBlob(entry.data, entry.mimeType);
    const thumbnail = await createThumbnail(original);
    records.push({
      id: entry.id,
      date: entry.date,
      view: entry.view,
      mimeType: entry.mimeType,
      blob: original,
      thumbnail: thumbnail.blob,
      width: thumbnail.width,
      height: thumbnail.height,
      createdAt: new Date().toISOString(),
      ...(owner ? { cloud: { owner, status: "pending" as const } } : {}),
    });
  }
  await mergePhotoRecords(records);
  if (records.length) dispatchPhotoChange();
  return records.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dispatchPhotoChange() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PHOTO_PROGRESS_CHANGE_EVENT));
}

function isValidDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isBase64(value: string) {
  if (!value.length || value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;
  if ((padding === 1 && contentLength % 4 !== 3) || (padding === 2 && contentLength % 4 !== 2)) return false;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47)) return false;
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return false;
  }
  return true;
}

function base64ByteLength(value: string) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function base64HasMimeSignature(data: string, mimeType: string) {
  try {
    const bytes = Uint8Array.from(atob(data.slice(0, 24)), (character) => character.charCodeAt(0));
    if (mimeType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (mimeType === "image/png") return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte);
    return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  } catch {
    return false;
  }
}

function base64ToBlob(data: string, mimeType: string) {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: mimeType });
  } catch (error) {
    throw new PhotoStorageError("Photo backup image data could not be decoded.", { cause: error });
  }
}

async function blobToBase64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x6000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

async function createPhotoVariants(blob: Blob): Promise<{ photo: Blob; thumbnail: Blob; width: number; height: number }> {
  let bitmap: ImageBitmap | undefined;
  let imageUrl: string | undefined;
  try {
    if (typeof createImageBitmap === "function") {
      bitmap = await createImageBitmap(blob);
      ensureSafeDimensions(bitmap.width, bitmap.height);
    } else {
      imageUrl = URL.createObjectURL(blob);
      const image = await loadImage(imageUrl);
      ensureSafeDimensions(image.naturalWidth, image.naturalHeight);
      const photo = await resizeImage(image, MAX_IMAGE_DIMENSION, 0.84);
      const thumbnail = await resizeImage(image, THUMBNAIL_DIMENSION, 0.68);
      return { photo, thumbnail, width: image.naturalWidth, height: image.naturalHeight };
    }
    const photo = await resizeImage(bitmap, MAX_IMAGE_DIMENSION, 0.84);
    const thumbnail = await resizeImage(bitmap, THUMBNAIL_DIMENSION, 0.68);
    return { photo, thumbnail, width: bitmap.width, height: bitmap.height };
  } catch (error) {
    throw new PhotoStorageError("Could not read this image. Choose a JPEG, PNG, or WebP photo supported by this browser.", { cause: error });
  } finally {
    bitmap?.close();
    if (imageUrl) URL.revokeObjectURL(imageUrl);
  }
}

async function createThumbnail(blob: Blob): Promise<{ blob: Blob; width: number; height: number }> {
  let bitmap: ImageBitmap | undefined;
  let imageUrl: string | undefined;
  try {
    if (typeof createImageBitmap === "function") {
      bitmap = await createImageBitmap(blob);
      ensureSafeDimensions(bitmap.width, bitmap.height);
      return { blob: await resizeImage(bitmap, THUMBNAIL_DIMENSION, 0.68), width: bitmap.width, height: bitmap.height };
    }
    imageUrl = URL.createObjectURL(blob);
    const image = await loadImage(imageUrl);
    ensureSafeDimensions(image.naturalWidth, image.naturalHeight);
    return { blob: await resizeImage(image, THUMBNAIL_DIMENSION, 0.68), width: image.naturalWidth, height: image.naturalHeight };
  } catch (error) {
    throw new PhotoStorageError("Could not read a photo in this backup. Choose images supported by this browser.", { cause: error });
  } finally {
    bitmap?.close();
    if (imageUrl) URL.revokeObjectURL(imageUrl);
  }
}

function ensureSafeDimensions(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width * height > MAX_DECODED_IMAGE_PIXELS) {
    throw new PhotoStorageError("This image has unsupported dimensions. Choose a smaller photo.");
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Image could not be decoded."));
    image.src = url;
  });
}

function resizeImage(source: CanvasImageSource & { width: number; height: number }, maxDimension: number, quality: number): Promise<Blob> {
  const scale = Math.min(1, maxDimension / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return Promise.reject(new PhotoStorageError("This browser could not prepare the photo."));
  context.drawImage(source, 0, 0, width, height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((result) => result ? resolve(result) : reject(new PhotoStorageError("This browser could not compress the photo.")), "image/jpeg", quality);
  });
}

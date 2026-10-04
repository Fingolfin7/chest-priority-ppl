import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_ACCOUNT_BYTES = Number(process.env.MAX_ACCOUNT_BYTES ?? 1024 * 1024 * 1024);
export const MAX_ACCOUNT_PHOTOS = Number(process.env.MAX_ACCOUNT_PHOTOS ?? 500);
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SUB = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MIME = ['image/jpeg', 'image/png', 'image/webp'];
// Records backups are gzip-compressed complete backups without photos. Base64
// inflation keeps 4 MiB under Lambda's 6 MB synchronous request limit.
export const MAX_RECORDS_BYTES = 4 * 1024 * 1024;
export const MAX_RECORDS_JSON_BYTES = 32 * 1024 * 1024;
export const MAX_RECORD_DEVICES = 20;
const DEVICE = /^[A-Za-z0-9_-]{8,64}$/;
const COPY_DATE = /^\d{4}-\d{2}-\d{2}$/;
export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const invalid = (message) => { throw new ApiError(400, 'INVALID_REQUEST', message); };
const deleted = () => { throw new ApiError(409, 'PHOTO_DELETED', 'This photo was deleted from cloud backup.'); };
const missing = () => { throw new ApiError(404, 'PHOTO_NOT_FOUND', 'Photo is not backed up.'); };
export function validId(id) { if (typeof id !== 'string' || !ID.test(id)) invalid('Invalid photo ID.'); return id; }
export function userFromEvent(event, clientId) {
  // Only API Gateway's verified authorizer context is trusted. Body/query identity is never accepted.
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  if (!claims || claims.token_use !== 'access' || claims.client_id !== clientId || !SUB.test(claims.sub ?? '')) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Sign in to back up your photos.');
  }
  return claims.sub;
}
export function validateMetadata(id, input) {
  validId(id);
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Photo metadata is required.');
  const allowed = ['date', 'view', 'mimeType', 'size', 'checksumSha256', 'width', 'height', 'createdAt'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) invalid('Unsupported photo metadata field.');
  if (typeof input.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)
    || !Number.isFinite(Date.parse(input.date)) || new Date(input.date).toISOString().slice(0, 10) !== input.date) invalid('Invalid photo date.');
  if (!['front', 'side', 'back'].includes(input.view)) invalid('Invalid photo view.');
  if (!MIME.includes(input.mimeType)) invalid('Only JPEG, PNG and WebP photos are supported.');
  if (!Number.isSafeInteger(input.size) || input.size < 12 || input.size > MAX_IMAGE_BYTES) invalid('Photo must be at most 8 MiB.');
  if (typeof input.checksumSha256 !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(input.checksumSha256)
    || Buffer.from(input.checksumSha256, 'base64').toString('base64') !== input.checksumSha256) invalid('A base64 SHA256 checksum is required.');
  if (!Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height) || input.width < 1 || input.height < 1
    || input.width * input.height > 100_000_000) invalid('Invalid photo dimensions.');
  if (typeof input.createdAt !== 'string' || !Number.isFinite(Date.parse(input.createdAt)) || input.createdAt.length > 40) invalid('Invalid creation time.');
  return { id, ...Object.fromEntries(allowed.map((key) => [key, input[key]])) };
}
export function hasImageSignature(bytes, mime) {
  if (mime === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === 'image/png') return [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v);
  return bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
}
export function publicPhoto(record) {
  const { id, date, view, mimeType, size, checksumSha256, width, height, createdAt, updatedAt } = record;
  return { id, date, view, mimeType, size, checksumSha256, width, height, createdAt, updatedAt };
}
export function createService({ store, objects, now = () => new Date().toISOString(), uuid = randomUUID }) {
  return {
    async list(user, cursor) {
      const page = await store.list(user, cursor);
      return { photos: page.records.filter((r) => r.state === 'active').map(publicPhoto),
        tombstones: page.records.filter((r) => r.state === 'deleted').map(({ id, deletedAt }) => ({ id, deletedAt })),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    },
    async prepare(user, id, input) {
      const metadata = validateMetadata(id, input);
      let record = await store.get(user, id);
      if (record?.state === 'deleted') deleted();
      if (record) {
        if (record.checksumSha256 !== metadata.checksumSha256 || record.size !== metadata.size || record.mimeType !== metadata.mimeType) {
          throw new ApiError(409, 'PHOTO_CONFLICT', 'This photo ID already has different image data.');
        }
        if (record.state === 'active') return { alreadyUploaded: true, photo: publicPhoto(record) };
      } else {
        const uploadId = uuid();
        record = { ...metadata, state: 'pending', uploadId, updatedAt: now(),
          stagingKey: `users/${user}/uploads/${id}/${uploadId}`, objectKey: `users/${user}/photos/${id}/${uploadId}` };
        if (!await store.reserve(user, record)) {
          const latest = await store.get(user, id);
          if (latest?.state === 'deleted') deleted();
          throw new ApiError(latest ? 409 : 413, latest ? 'PHOTO_CONFLICT' : 'BACKUP_LIMIT',
            latest ? 'Photo changed while preparing backup. Retry.' : 'Your cloud photo backup storage limit has been reached.');
        }
      }
      return { uploadId: record.uploadId, ...await objects.prepare(record) };
    },
    async confirm(user, id, input) {
      validId(id);
      if (!input || typeof input.uploadId !== 'string' || !SUB.test(input.uploadId) || Object.keys(input).some((k) => k !== 'uploadId')) invalid('Invalid upload confirmation.');
      const record = await store.get(user, id);
      if (record?.state === 'deleted') deleted();
      if (!record) missing();
      if (record.uploadId !== input.uploadId) throw new ApiError(409, 'PHOTO_CONFLICT', 'Upload no longer matches this photo.');
      if (record.state === 'active') return { photo: publicPhoto(record) };
      await objects.validateAndCopy(record);
      const updatedAt = now();
      if (!await store.activate(user, id, record.uploadId, updatedAt)) {
        const latest = await store.get(user, id);
        if (latest?.state === 'active' && latest.uploadId === record.uploadId) return { photo: publicPhoto(latest) };
        // DynamoDB can cancel a competing transaction while its winner is still in flight.
        // Both confirmations share this final key; removing it here could destroy the winner's image.
        if (latest?.state === 'pending' && latest.uploadId === record.uploadId) {
          throw new ApiError(409, 'PHOTO_CONFLICT', 'Photo confirmation is busy. Retry.');
        }
        await objects.remove(record.objectKey);
        if (latest?.state === 'deleted') deleted();
        throw new ApiError(409, 'PHOTO_CONFLICT', 'Photo changed during upload. Retry.');
      }
      // A failure here is harmless: the staging lifecycle expires the duplicate, and confirm is idempotent.
      await objects.remove(record.stagingKey).catch(() => {});
      return { photo: publicPhoto({ ...record, updatedAt }) };
    },
    async download(user, id) {
      validId(id);
      const record = await store.get(user, id);
      if (record?.state === 'deleted') deleted();
      if (!record || record.state !== 'active') missing();
      return { photo: publicPhoto(record), ...await objects.download(record) };
    },
    async delete(user, id) {
      validId(id);
      // Persist deletion first. Any delayed prepare or confirm must fail after this point.
      const record = await store.tombstone(user, id, now());
      for (const key of [record.objectKey, record.stagingKey].filter(Boolean)) await objects.remove(key);
      return { id, deletedAt: record.deletedAt };
    },
  };
}

export function validDevice(device) { if (typeof device !== 'string' || !DEVICE.test(device)) invalid('Invalid backup device.'); return device; }
export function deviceLabel(value) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > 200) invalid('Invalid device name.');
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
}
// The summary is computed here rather than trusted from the client, so the
// restore list always describes what the stored file actually contains.
export function summarizeRecords(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 18) invalid('A records backup is required.');
  if (bytes.length > MAX_RECORDS_BYTES) throw new ApiError(413, 'BACKUP_LIMIT', 'This records backup is larger than 4 MiB compressed.');
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) invalid('Records backup must be gzip compressed.');
  let value;
  try { value = JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_RECORDS_JSON_BYTES }).toString('utf8')); }
  catch { invalid('Records backup could not be read.'); }
  const snapshot = value?.snapshot;
  if (!value || typeof value !== 'object' || value.schema !== 'rolling-ppl-complete-backup' || value.version !== 1 || value.photosIncluded !== false
    || !Array.isArray(value.photos?.photos) || value.photos.photos.length || !snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.completed)) {
    invalid('This is not a Rolling PPL records backup.');
  }
  const count = (list) => Array.isArray(list) ? list.length : 0;
  return { workouts: snapshot.completed.length, foodDays: count(snapshot.nutrition?.days),
    weighIns: Math.max(count(snapshot.bodyProgress?.weighIns), count(value.body?.weighIns)) };
}
export function createRecordsService({ records, now = () => new Date().toISOString() }) {
  return {
    async list(user) {
      const devices = await records.list(user);
      return { devices: devices.sort((a, b) => b.savedAt.localeCompare(a.savedAt)) };
    },
    async put(user, device, bytes, name) {
      validDevice(device);
      const summary = summarizeRecords(bytes);
      const label = deviceLabel(name);
      if (!await records.exists(user, device) && await records.deviceCount(user) >= MAX_RECORD_DEVICES) {
        throw new ApiError(413, 'BACKUP_LIMIT', `Cloud records backup supports ${MAX_RECORD_DEVICES} browsers per account.`);
      }
      const savedAt = now();
      const latest = { device, name: label, savedAt, size: bytes.length, ...summary };
      // Each browser writes only its own copies, so a new or cleared browser can never replace another browser's backup.
      await records.put(user, device, bytes, latest, savedAt.slice(0, 10));
      return { latest };
    },
    async download(user, device, copy = 'latest') {
      validDevice(device);
      if (copy !== 'latest' && (typeof copy !== 'string' || !COPY_DATE.test(copy))) invalid('Invalid backup copy.');
      const result = await records.download(user, device, copy);
      if (!result) throw new ApiError(404, 'RECORDS_NOT_FOUND', 'This cloud records copy no longer exists.');
      return result;
    },
  };
}

export function createHandler(service, clientId, recordsService) {
  return async (event) => {
    try {
      const user = userFromEvent(event, clientId);
      const method = event.requestContext?.http?.method;
      const path = event.rawPath;
      const raw = event.body ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8') : undefined;
      const records = /^\/records(?:\/([A-Za-z0-9_-]{1,128})(?:\/(download))?)?$/.exec(path ?? '');
      let body;
      if (raw && !(records && method === 'PUT')) {
        if (raw.length > 4096) invalid('Request is too large.');
        try { body = JSON.parse(raw.toString('utf8')); } catch { invalid('Invalid JSON request.'); }
      }
      let result;
      if (records && recordsService) {
        const [, device, action] = records;
        if (method === 'GET' && !device) result = await recordsService.list(user);
        else if (method === 'PUT' && device && !action) result = await recordsService.put(user, device, raw, event.queryStringParameters?.name);
        else if (method === 'GET' && device && action) result = await recordsService.download(user, device, event.queryStringParameters?.copy);
        else throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found.');
      } else if (method === 'GET' && path === '/photos') result = await service.list(user, event.queryStringParameters?.cursor);
      else {
        const match = /^\/photos\/([A-Za-z0-9_-]{1,128})(?:\/(upload|confirm|download))?$/.exec(path ?? '');
        if (!match) throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found.');
        const [, id, action] = match;
        if (method === 'POST' && action === 'upload') result = await service.prepare(user, id, body);
        else if (method === 'POST' && action === 'confirm') result = await service.confirm(user, id, body);
        else if (method === 'GET' && action === 'download') result = await service.download(user, id);
        else if (method === 'DELETE' && !action) result = await service.delete(user, id);
        else throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found.');
      }
      return { statusCode: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(result) };
    } catch (error) {
      if (!(error instanceof ApiError)) console.error('Photo backup request failed', { name: error?.name });
      return { statusCode: error instanceof ApiError ? error.status : 500,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        body: JSON.stringify({ error: { code: error instanceof ApiError ? error.code : 'INTERNAL_ERROR',
          message: error instanceof ApiError ? error.message : 'Cloud backup is temporarily unavailable. Try again.' } }) };
    }
  };
}

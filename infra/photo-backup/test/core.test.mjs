import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ApiError, createService, createHandler, validateMetadata, userFromEvent, hasImageSignature, MAX_IMAGE_BYTES } from '../core.mjs';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const UPLOAD = '33333333-3333-4333-8333-333333333333';
const time = '2026-10-02T12:00:00.000Z';
const input = { date: '2026-10-02', view: 'front', mimeType: 'image/jpeg', size: 20,
  checksumSha256: createHash('sha256').update('photo').digest('base64'), width: 100, height: 200, createdAt: time };
const apiEvent = (user = ALICE) => ({ rawPath: '/photos', requestContext: { http: { method: 'GET' },
  authorizer: { jwt: { claims: { sub: user, token_use: 'access', client_id: 'public-client' } } } } });
function fixture() {
  const records = new Map(); const removed = []; const copied = []; const signed = [];
  const recordKey = (user, id) => `${user}/${id}`;
  const store = {
    async get(user, id) { return structuredClone(records.get(recordKey(user, id))); },
    async list(user) { return { records: [...records.entries()].filter(([key]) => key.startsWith(`${user}/`)).map(([, item]) => structuredClone(item)) }; },
    async reserve(user, record) { const key = recordKey(user, record.id); if (records.has(key)) return false; records.set(key, structuredClone(record)); return true; },
    async activate(user, id, uploadId, updatedAt) { const record = records.get(recordKey(user, id));
      if (!record || record.state !== 'pending' || record.uploadId !== uploadId) return false;
      Object.assign(record, { state: 'active', updatedAt }); return true; },
    async tombstone(user, id, deletedAt) { const key = recordKey(user, id); const existing = records.get(key);
      if (existing?.state === 'deleted') return structuredClone(existing);
      const result = { ...existing, id, state: 'deleted', deletedAt }; records.set(key, result); return structuredClone(result); },
  };
  const objects = {
    async prepare(record) { signed.push(record.stagingKey); return { url: 'https://private.invalid', fields: { key: record.stagingKey }, expiresAt: time }; },
    async validateAndCopy(record) { copied.push(record.objectKey); },
    async remove(key) { removed.push(key); },
    async download(record) { signed.push(record.objectKey); return { url: 'https://private.invalid/download', expiresAt: time }; },
  };
  return { service: createService({ store, objects, now: () => time, uuid: () => UPLOAD }), store, objects, records, removed, copied, signed, recordKey };
}

test('only verified Cognito access token context from the configured client supplies identity', () => {
  assert.equal(userFromEvent(apiEvent(), 'public-client'), ALICE);
  for (const claims of [{ sub: ALICE, token_use: 'id', client_id: 'public-client' },
    { sub: ALICE, token_use: 'access', client_id: 'other-client' }, { sub: '../../victim', token_use: 'access', client_id: 'public-client' }]) {
    const event = apiEvent(); event.requestContext.authorizer.jwt.claims = claims;
    assert.throws(() => userFromEvent(event, 'public-client'), { status: 401 });
  }
  assert.throws(() => userFromEvent({ headers: { authorization: 'fake' }, body: JSON.stringify({ sub: ALICE }) }, 'public-client'), { status: 401 });
});
test('metadata validation rejects traversal, arbitrary keys, oversize, unsupported type and noncanonical checksum', () => {
  assert.equal(validateMetadata('photo-1', input).id, 'photo-1');
  assert.throws(() => validateMetadata('../other', input), ApiError);
  for (const patch of [{ user: BOB }, { objectKey: 'autumn/photos' }, { size: MAX_IMAGE_BYTES + 1 }, { size: 0 },
    { mimeType: 'text/html' }, { checksumSha256: 'bad' }, { date: '2026-02-30' }, { width: 0 }, { width: 100000, height: 100000 }]) {
    assert.throws(() => validateMetadata('photo-1', { ...input, ...patch }), ApiError);
  }
});
test('each signed key uses authorizer subject and no other user can discover or download the photo', async () => {
  const f = fixture(); await f.service.prepare(ALICE, 'photo-1', input);
  assert.equal(f.signed[0], `users/${ALICE}/uploads/photo-1/${UPLOAD}`);
  await f.service.confirm(ALICE, 'photo-1', { uploadId: UPLOAD });
  assert.deepEqual(await f.service.list(BOB), { photos: [], tombstones: [] });
  await assert.rejects(f.service.download(BOB, 'photo-1'), { status: 404 });
  await f.service.delete(BOB, 'photo-1');
  assert.equal((await f.service.list(ALICE)).photos.length, 1);
  const alice = await f.service.download(ALICE, 'photo-1');
  assert.equal(alice.photo.id, 'photo-1');
  assert.equal('objectKey' in alice.photo, false);
});
test('active uploads and confirmations are idempotent while different bytes for an ID conflict', async () => {
  const f = fixture(); await f.service.prepare(ALICE, 'photo-1', input);
  await f.service.confirm(ALICE, 'photo-1', { uploadId: UPLOAD });
  assert.equal((await f.service.prepare(ALICE, 'photo-1', input)).alreadyUploaded, true);
  await f.service.confirm(ALICE, 'photo-1', { uploadId: UPLOAD });
  assert.equal(f.copied.length, 1);
  await assert.rejects(f.service.prepare(ALICE, 'photo-1', { ...input, size: 21 }), { code: 'PHOTO_CONFLICT' });
});
test('delete durably tombstones an ID even before any upload and stale devices cannot reupload', async () => {
  const f = fixture(); await f.service.delete(ALICE, 'photo-1');
  await assert.rejects(f.service.prepare(ALICE, 'photo-1', input), { code: 'PHOTO_DELETED' });
  await assert.rejects(f.service.confirm(ALICE, 'photo-1', { uploadId: UPLOAD }), { code: 'PHOTO_DELETED' });
  assert.deepEqual((await f.service.list(ALICE)).tombstones, [{ id: 'photo-1', deletedAt: time }]);
});
test('delete racing with confirmation wins and orphaned copied bytes are removed', async () => {
  const f = fixture(); await f.service.prepare(ALICE, 'photo-1', input);
  f.objects.validateAndCopy = async (record) => { f.copied.push(record.objectKey); await f.service.delete(ALICE, 'photo-1'); };
  await assert.rejects(f.service.confirm(ALICE, 'photo-1', { uploadId: UPLOAD }), { code: 'PHOTO_DELETED' });
  assert.ok(f.removed.includes(`users/${ALICE}/photos/photo-1/${UPLOAD}`));
  assert.equal((await f.service.list(ALICE)).photos.length, 0);
});
test('two concurrent confirmations never delete the other successful confirmation', async () => {
  const f = fixture(); await f.service.prepare(ALICE, 'photo-1', input);
  let entrants = 0; let unblock; const barrier = new Promise((resolve) => { unblock = resolve; });
  f.objects.validateAndCopy = async () => { entrants++; if (entrants === 2) unblock(); await barrier; };
  const results = await Promise.all([f.service.confirm(ALICE, 'photo-1', { uploadId: UPLOAD }), f.service.confirm(ALICE, 'photo-1', { uploadId: UPLOAD })]);
  assert.equal(results.length, 2); assert.equal((await f.service.list(ALICE)).photos.length, 1);
  assert.equal(f.removed.includes(`users/${ALICE}/photos/photo-1/${UPLOAD}`), false);
});
test('a transaction conflict while another confirm is still pending never removes their shared final object', async () => {
  const f = fixture(); await f.service.prepare(ALICE, 'photo-1', input);
  const activate = f.store.activate; f.store.activate = async () => false;
  await assert.rejects(f.service.confirm(ALICE, 'photo-1', { uploadId: UPLOAD }), { code: 'PHOTO_CONFLICT' });
  assert.equal(f.removed.includes(`users/${ALICE}/photos/photo-1/${UPLOAD}`), false);
  f.store.activate = activate;
  await f.service.confirm(ALICE, 'photo-1', { uploadId: UPLOAD });
  assert.equal((await f.service.list(ALICE)).photos.length, 1);
});
test('failed byte validation cannot add an active manifest record', async () => {
  const f = fixture(); await f.service.prepare(ALICE, 'photo-1', input);
  f.objects.validateAndCopy = async () => { throw new ApiError(400, 'UPLOAD_INVALID', 'bad checksum'); };
  await assert.rejects(f.service.confirm(ALICE, 'photo-1', { uploadId: UPLOAD }), { code: 'UPLOAD_INVALID' });
  assert.deepEqual((await f.service.list(ALICE)).photos, []);
});
test('failed object deletion keeps tombstone and can retry removal after transient failure', async () => {
  const f = fixture(); await f.service.prepare(ALICE, 'photo-1', input); await f.service.confirm(ALICE, 'photo-1', { uploadId: UPLOAD });
  const original = f.objects.remove; f.objects.remove = async () => { throw new Error('temporary outage'); };
  await assert.rejects(f.service.delete(ALICE, 'photo-1'));
  assert.equal((await f.service.list(ALICE)).tombstones.length, 1);
  f.objects.remove = original; await f.service.delete(ALICE, 'photo-1');
  assert.ok(f.removed.includes(`users/${ALICE}/photos/photo-1/${UPLOAD}`));
});
test('handler rejects unverified input, oversized JSON and unsupported user fields without leaking errors', async () => {
  const f = fixture(); const handler = createHandler(f.service, 'public-client');
  assert.equal((await handler({ rawPath: '/photos', requestContext: { http: { method: 'GET' } } })).statusCode, 401);
  const event = apiEvent(); event.rawPath = '/photos/photo-1/upload'; event.requestContext.http.method = 'POST'; event.body = JSON.stringify({ ...input, user: BOB });
  assert.equal((await handler(event)).statusCode, 400);
  event.body = 'x'.repeat(4097); assert.equal((await handler(event)).statusCode, 400);
  event.body = JSON.stringify(input); const response = await handler(event);
  assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(JSON.parse(response.body).fields.key, `users/${ALICE}/uploads/photo-1/${UPLOAD}`);
});
test('magic signatures validate claimed MIME before finalizing objects', () => {
  assert.ok(hasImageSignature(Buffer.from([255, 216, 255]), 'image/jpeg'));
  assert.ok(hasImageSignature(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'image/png'));
  assert.ok(hasImageSignature(Buffer.from('RIFFabcdWEBP'), 'image/webp'));
  assert.equal(hasImageSignature(Buffer.from('<html>bad</html>'), 'image/jpeg'), false);
  assert.equal(hasImageSignature(Buffer.from('RIFFabcdNOPE'), 'image/webp'), false);
});

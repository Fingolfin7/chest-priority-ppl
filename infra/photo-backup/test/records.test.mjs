import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { createHandler, createRecordsService, createService, summarizeRecords, MAX_RECORD_DEVICES, MAX_RECORDS_BYTES } from '../core.mjs';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const PHONE = 'aaaaaaaa-0000-4000-8000-000000000001';
const LAPTOP = 'bbbbbbbb-0000-4000-8000-000000000002';
const backup = (patch = {}) => ({ schema: 'rolling-ppl-complete-backup', version: 1, exportedAt: '2026-10-05T08:00:00.000Z', photosIncluded: false,
  snapshot: { completed: [{ id: 'w1' }, { id: 'w2' }], nutrition: { days: [{ date: '2026-10-04' }] }, bodyProgress: { weighIns: [{ id: 'b1' }] } },
  body: { weighIns: [{ id: 'b1' }] }, photos: { schema: 'rolling-ppl-progress-photos', version: 1, photos: [] }, ...patch });
const gz = (value) => gzipSync(Buffer.from(JSON.stringify(value)));

function fixture(clock = ['2026-10-04T21:00:00.000Z']) {
  const objects = new Map();
  const records = {
    async exists(user, device) { return objects.has(`${user}/${device}/latest`); },
    async deviceCount(user) { return new Set([...objects.keys()].filter((key) => key.startsWith(`${user}/`)).map((key) => key.split('/')[1])).size; },
    async put(user, device, bytes, latest, day) { objects.set(`${user}/${device}/${day}`, { bytes, latest }); objects.set(`${user}/${device}/latest`, { bytes, latest }); },
    async list(user) {
      return [...objects.entries()].filter(([key]) => key.startsWith(`${user}/`) && key.endsWith('/latest'))
        .map(([key, value]) => ({ ...value.latest, copies: [...objects.keys()].filter((other) => other.startsWith(key.replace(/latest$/, '')) && !other.endsWith('latest')).map((other) => ({ date: other.split('/')[2] })) }));
    },
    async download(user, device, copy) { const found = objects.get(`${user}/${device}/${copy}`); return found && { url: `https://private.invalid/${user}/${device}/${copy}`, copy: found.latest }; },
  };
  let index = 0;
  return { objects, service: createRecordsService({ records, now: () => clock[Math.min(index++, clock.length - 1)] }) };
}
const event = (method, path, body, query) => ({ rawPath: path, queryStringParameters: query, isBase64Encoded: Boolean(body), body: body?.toString('base64'),
  requestContext: { http: { method }, authorizer: { jwt: { claims: { sub: ALICE, token_use: 'access', client_id: 'public-client' } } } } });

test('summaries come from the stored file, not client claims', () => {
  assert.deepEqual(summarizeRecords(gz(backup())), { workouts: 2, foodDays: 1, weighIns: 1 });
  assert.deepEqual(summarizeRecords(gz(backup({ snapshot: { completed: [] } }))), { workouts: 0, foodDays: 0, weighIns: 1 });
});
test('only gzip-compressed records-only complete backups are accepted', () => {
  for (const bytes of [Buffer.from(JSON.stringify(backup())), gz({ schema: 'other' }), gz(backup({ photosIncluded: true })),
    gz(backup({ photos: { photos: [{ id: 'p' }] } })), gz(backup({ snapshot: {} })), Buffer.from([0x1f, 0x8b, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])]) {
    assert.throws(() => summarizeRecords(bytes), { status: 400 });
  }
  assert.throws(() => summarizeRecords(Buffer.concat([gz(backup()), Buffer.alloc(MAX_RECORDS_BYTES)])), { status: 413 });
});
test('each browser keeps its own latest and daily copies per account', async () => {
  const f = fixture(['2026-10-04T21:00:00.000Z', '2026-10-05T07:00:00.000Z', '2026-10-05T08:00:00.000Z']);
  await f.service.put(ALICE, PHONE, gz(backup()), 'My phone');
  await f.service.put(ALICE, PHONE, gz(backup()), 'My phone');
  const { latest } = await f.service.put(ALICE, LAPTOP, gz(backup({ snapshot: { completed: [] } })), 'My laptop\u0000');
  assert.deepEqual(latest, { device: LAPTOP, name: 'My laptop', savedAt: '2026-10-05T08:00:00.000Z', size: latest.size, workouts: 0, foodDays: 0, weighIns: 1 });
  const list = await f.service.list(ALICE);
  assert.deepEqual(list.devices.map((item) => item.device), [LAPTOP, PHONE]);
  assert.deepEqual(list.devices[1].copies.map((copy) => copy.date).sort(), ['2026-10-04', '2026-10-05']);
  assert.deepEqual(await f.service.list(BOB), { devices: [] });
  await assert.rejects(f.service.download(BOB, PHONE), { status: 404 });
  assert.equal((await f.service.download(ALICE, PHONE, '2026-10-04')).copy.workouts, 2);
});
test('device IDs and copy names are validated before storage keys are built', async () => {
  const f = fixture();
  for (const device of ['../x', 'short', `${'a'.repeat(65)}`]) await assert.rejects(f.service.put(ALICE, device, gz(backup())), { status: 400 });
  for (const copy of ['../latest', '2026-1-1', 'daily']) await assert.rejects(f.service.download(ALICE, PHONE, copy), { status: 400 });
});
test('the number of browsers per account is capped, but existing browsers can keep saving', async () => {
  const f = fixture();
  for (let index = 0; index < MAX_RECORD_DEVICES; index++) await f.service.put(ALICE, `device-${String(index).padStart(4, '0')}`, gz(backup()));
  await assert.rejects(f.service.put(ALICE, 'device-overflow', gz(backup())), { status: 413, code: 'BACKUP_LIMIT' });
  await f.service.put(ALICE, 'device-0000', gz(backup()));
});
test('the handler accepts binary records uploads but keeps the small JSON limit elsewhere', async () => {
  const f = fixture();
  const handler = createHandler(createService({ store: {}, objects: {} }), 'public-client', f.service);
  const bytes = gz(backup({ padding: randomBytes(8000).toString('hex') }));
  assert.ok(bytes.length > 4096);
  const put = await handler(event('PUT', `/records/${PHONE}`, bytes, { name: 'My phone' }));
  assert.equal(put.statusCode, 200);
  assert.equal(JSON.parse(put.body).latest.name, 'My phone');
  const list = await handler(event('GET', '/records'));
  assert.equal(JSON.parse(list.body).devices.length, 1);
  const download = await handler(event('GET', `/records/${PHONE}/download`, undefined, { copy: 'latest' }));
  assert.equal(JSON.parse(download.body).url, `https://private.invalid/${ALICE}/${PHONE}/latest`);
  assert.equal((await handler(event('POST', `/records/${PHONE}`, bytes))).statusCode, 400);
  assert.equal((await handler(event('DELETE', `/records/${PHONE}`))).statusCode, 404);
  assert.equal((await handler({ ...event('GET', '/records'), requestContext: { http: { method: 'GET' } } })).statusCode, 401);
});

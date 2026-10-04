import { S3Client, HeadObjectCommand, GetObjectCommand, CopyObjectCommand, DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ApiError, createService, createHandler, createRecordsService, hasImageSignature, MAX_ACCOUNT_BYTES, MAX_ACCOUNT_PHOTOS } from './core.mjs';

const table = process.env.MANIFEST_TABLE;
const bucket = process.env.PHOTO_BUCKET;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const s3 = new S3Client({});
const key = (user, id) => ({ PK: `USER#${user}`, SK: `PHOTO#${id}` });
const statsKey = (user) => ({ PK: `USER#${user}`, SK: 'STATS' });
const conflict = (e) => e.name === 'TransactionCanceledException' || e.name === 'ConditionalCheckFailedException';
const timestamp = () => new Date().toISOString();
const expiryCutoff = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();

async function releasePending(record) {
  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: [
      { Delete: { TableName: table, Key: { PK: record.PK, SK: record.SK },
        ConditionExpression: '#state = :pending AND updatedAt < :cutoff',
        ExpressionAttributeNames: { '#state': 'state' }, ExpressionAttributeValues: { ':pending': 'pending', ':cutoff': expiryCutoff() } } },
      { Update: { TableName: table, Key: { PK: record.PK, SK: 'STATS' },
        UpdateExpression: 'ADD photoCount :count, photoBytes :bytes', ExpressionAttributeValues: { ':count': -1, ':bytes': -record.size } } },
    ] }));
    // If a Lambda crashed after copying, remove its uncommitted durable object as well.
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: record.objectKey }));
    // Uploaded staging bytes expire through S3 lifecycle. A replay of the old signed POST has no manifest to confirm.
    return true;
  } catch (e) { if (conflict(e)) return false; throw e; }
}
async function cleanupExpired(user) {
  let cursor;
  do {
    const response = user
      ? await ddb.send(new QueryCommand({ TableName: table, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :photo)',
        ExpressionAttributeValues: { ':pk': `USER#${user}`, ':photo': 'PHOTO#' }, ExclusiveStartKey: cursor, ConsistentRead: true }))
      : await ddb.send(new ScanCommand({ TableName: table, FilterExpression: '#state = :pending AND updatedAt < :cutoff',
        ExpressionAttributeNames: { '#state': 'state' }, ExpressionAttributeValues: { ':pending': 'pending', ':cutoff': expiryCutoff() }, ExclusiveStartKey: cursor }));
    for (const record of response.Items ?? []) {
      if (record.state === 'pending' && record.updatedAt < expiryCutoff()) await releasePending(record);
    }
    cursor = response.LastEvaluatedKey;
  } while (cursor);
}

const store = {
  async get(user, id) {
    let record = (await ddb.send(new GetCommand({ TableName: table, Key: key(user, id), ConsistentRead: true }))).Item;
    if (record?.state === 'pending' && record.updatedAt < expiryCutoff() && await releasePending(record)) record = undefined;
    return record;
  },
  async list(user, cursor) {
    let start;
    if (cursor) {
      try {
        if (cursor.length > 1024) throw new Error();
        start = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (start.PK !== `USER#${user}` || typeof start.SK !== 'string' || !/^PHOTO#[A-Za-z0-9_-]{1,128}$/.test(start.SK)
          || Object.keys(start).length !== 2) throw new Error();
      } catch { throw new ApiError(400, 'INVALID_REQUEST', 'Invalid photo list cursor.'); }
    }
    const result = await ddb.send(new QueryCommand({ TableName: table, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :photo)',
      ExpressionAttributeValues: { ':pk': `USER#${user}`, ':photo': 'PHOTO#' }, ExclusiveStartKey: start, ConsistentRead: true, Limit: 100 }));
    return { records: result.Items ?? [], nextCursor: result.LastEvaluatedKey ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64url') : undefined };
  },
  async reserve(user, record) {
    const attempt = async () => {
      try {
        await ddb.send(new TransactWriteCommand({ TransactItems: [
          { Put: { TableName: table, Item: { ...key(user, record.id), ...record }, ConditionExpression: 'attribute_not_exists(PK)' } },
          { Update: { TableName: table, Key: statsKey(user), UpdateExpression: 'ADD photoCount :one, photoBytes :size',
            ConditionExpression: '(attribute_not_exists(photoCount) OR photoCount < :maxCount) AND (attribute_not_exists(photoBytes) OR photoBytes <= :remaining)',
            ExpressionAttributeValues: { ':one': 1, ':size': record.size, ':maxCount': MAX_ACCOUNT_PHOTOS, ':remaining': MAX_ACCOUNT_BYTES - record.size } } },
        ] })); return true;
      } catch (e) { if (conflict(e)) return false; throw e; }
    };
    if (await attempt()) return true;
    await cleanupExpired(user);
    return attempt();
  },
  async activate(user, id, uploadId, updatedAt) {
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: [{ Update: { TableName: table, Key: key(user, id),
        UpdateExpression: 'SET #state = :active, updatedAt = :time', ConditionExpression: '#state = :pending AND uploadId = :upload',
        ExpressionAttributeNames: { '#state': 'state' }, ExpressionAttributeValues: { ':active': 'active', ':pending': 'pending', ':upload': uploadId, ':time': updatedAt } } }] }));
      return true;
    } catch (e) {
      if (conflict(e)) {
        const latest = await store.get(user, id);
        return latest?.state === 'active' && latest.uploadId === uploadId;
      }
      throw e;
    }
  },
  async tombstone(user, id, deletedAt) {
    for (let retry = 0; retry < 5; retry++) {
      const existing = await store.get(user, id);
      if (existing?.state === 'deleted') return existing;
      // Keep internal object keys in the tombstone so a failed S3 deletion can be retried durably.
      const tombstone = { ...key(user, id), id, state: 'deleted', deletedAt,
        objectKey: existing?.objectKey, stagingKey: existing?.stagingKey };
      const transactions = [{ Put: { TableName: table, Item: tombstone,
        ConditionExpression: existing ? '#state = :expected AND uploadId = :upload' : 'attribute_not_exists(PK)',
        ...(existing ? { ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: { ':expected': existing.state, ':upload': existing.uploadId } } : {}) } }];
      if (existing) transactions.push({ Update: { TableName: table, Key: statsKey(user),
        UpdateExpression: 'ADD photoCount :count, photoBytes :bytes', ExpressionAttributeValues: { ':count': -1, ':bytes': -existing.size } } });
      try { await ddb.send(new TransactWriteCommand({ TransactItems: transactions })); return tombstone; }
      catch (e) { if (!conflict(e)) throw e; }
    }
    throw new ApiError(409, 'PHOTO_CONFLICT', 'Photo is changing on another device. Retry deletion.');
  },
};

const objects = {
  async prepare(record) {
    const tagging = '<Tagging><TagSet><Tag><Key>staging</Key><Value>true</Value></Tag></TagSet></Tagging>';
    const result = await createPresignedPost(s3, { Bucket: bucket, Key: record.stagingKey, Expires: 600,
      Fields: { 'Content-Type': record.mimeType, 'x-amz-checksum-algorithm': 'SHA256', 'x-amz-checksum-sha256': record.checksumSha256,
        'x-amz-server-side-encryption': 'AES256', success_action_status: '204', tagging },
      Conditions: [['content-length-range', record.size, record.size], ['eq', '$Content-Type', record.mimeType],
        ['eq', '$x-amz-checksum-algorithm', 'SHA256'], ['eq', '$x-amz-checksum-sha256', record.checksumSha256],
        ['eq', '$x-amz-server-side-encryption', 'AES256'], ['eq', '$success_action_status', '204'], ['eq', '$tagging', tagging]] });
    return { ...result, expiresAt: new Date(Date.now() + 600000).toISOString() };
  },
  async validateAndCopy(record) {
    let head;
    try { head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: record.stagingKey, ChecksumMode: 'ENABLED' })); }
    catch (e) { if (e.$metadata?.httpStatusCode === 404) throw new ApiError(409, 'UPLOAD_MISSING', 'Upload the photo before confirming.'); throw e; }
    if (head.ContentLength !== record.size || head.ContentType !== record.mimeType || head.ChecksumSHA256 !== record.checksumSha256) {
      throw new ApiError(400, 'UPLOAD_INVALID', 'Uploaded size, type or checksum does not match the photo.');
    }
    const firstBytes = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: record.stagingKey, Range: 'bytes=0-11', IfMatch: head.ETag }));
    if (!hasImageSignature(Buffer.from(await firstBytes.Body.transformToByteArray()), record.mimeType)) {
      throw new ApiError(400, 'UPLOAD_INVALID', 'Uploaded image data does not match its image type.');
    }
    // Immutable final objects cannot be overwritten by replaying a presigned staging POST.
    await s3.send(new CopyObjectCommand({ Bucket: bucket, Key: record.objectKey,
      CopySource: `${bucket}/${record.stagingKey.split('/').map(encodeURIComponent).join('/')}`, CopySourceIfMatch: head.ETag,
      ServerSideEncryption: 'AES256', ChecksumAlgorithm: 'SHA256', TaggingDirective: 'REPLACE', Tagging: '' }));
  },
  async remove(objectKey) { await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey })); },
  async download(record) {
    return { url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: record.objectKey,
      ResponseContentType: record.mimeType, ResponseCacheControl: 'private, no-store' }), { expiresIn: 300 }),
      expiresAt: new Date(Date.now() + 300000).toISOString() };
  },
};

// Records backups: users/<sub>/records/<device>/latest.json.gz plus one tagged
// copy per UTC day that the bucket lifecycle expires. Keys are built only here.
const recordsPrefix = (user) => `users/${user}/records/`;
const recordsKey = (user, device, copy) => `${recordsPrefix(user)}${device}/${copy === 'latest' ? 'latest' : `daily/${copy}`}.json.gz`;
const missingObject = (e) => e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404;
async function headRecords(user, device, copy) {
  try { return await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: recordsKey(user, device, copy) })); }
  catch (e) { if (missingObject(e)) return undefined; throw e; }
}
function recordsSummary(device, head) {
  const meta = head.Metadata ?? {};
  const number = (value) => Number.isSafeInteger(Number(value)) ? Number(value) : 0;
  let name = '';
  try { name = decodeURIComponent(meta['device-name'] ?? ''); } catch { /* Show the copy without a label. */ }
  return { device, name, savedAt: meta['saved-at'] ?? head.LastModified?.toISOString() ?? '', size: head.ContentLength ?? 0,
    workouts: number(meta.workouts), foodDays: number(meta['food-days']), weighIns: number(meta['weigh-ins']) };
}
async function listRecordKeys(user, delimiter) {
  const contents = []; const prefixes = []; let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: recordsPrefix(user), Delimiter: delimiter, ContinuationToken: token }));
    contents.push(...(page.Contents ?? [])); prefixes.push(...(page.CommonPrefixes ?? []));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return { contents, prefixes };
}
const records = {
  async exists(user, device) { return Boolean(await headRecords(user, device, 'latest')); },
  async deviceCount(user) { return (await listRecordKeys(user, '/')).prefixes.length; },
  async put(user, device, bytes, latest, day) {
    const Metadata = { 'saved-at': latest.savedAt, workouts: String(latest.workouts), 'food-days': String(latest.foodDays),
      'weigh-ins': String(latest.weighIns), 'device-name': encodeURIComponent(latest.name) };
    const common = { Bucket: bucket, Body: bytes, ContentType: 'application/gzip', ServerSideEncryption: 'AES256', Metadata };
    await s3.send(new PutObjectCommand({ ...common, Key: recordsKey(user, device, day), Tagging: 'records-history=true' }));
    await s3.send(new PutObjectCommand({ ...common, Key: recordsKey(user, device, 'latest') }));
  },
  async list(user) {
    const devices = new Map();
    const pattern = /^([A-Za-z0-9_-]{8,64})\/(?:latest|daily\/(\d{4}-\d{2}-\d{2}))\.json\.gz$/;
    for (const object of (await listRecordKeys(user)).contents) {
      const match = pattern.exec(object.Key.slice(recordsPrefix(user).length));
      if (!match) continue;
      const [, device, date] = match;
      const entry = devices.get(device) ?? { copies: [] };
      if (date) entry.copies.push({ date, size: object.Size ?? 0, savedAt: object.LastModified?.toISOString() ?? '' });
      else entry.latest = true;
      devices.set(device, entry);
    }
    const result = [];
    for (const [device, entry] of devices) {
      if (!entry.latest) continue;
      const head = await headRecords(user, device, 'latest');
      if (head) result.push({ ...recordsSummary(device, head), copies: entry.copies.sort((a, b) => b.date.localeCompare(a.date)) });
    }
    return result;
  },
  async download(user, device, copy) {
    const head = await headRecords(user, device, copy);
    if (!head) return undefined;
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: recordsKey(user, device, copy),
      ResponseContentType: 'application/gzip', ResponseCacheControl: 'private, no-store' }), { expiresIn: 300 });
    return { url, expiresAt: new Date(Date.now() + 300000).toISOString(), copy: recordsSummary(device, head) };
  },
};

const apiHandler = createHandler(createService({ store, objects }), process.env.CLIENT_ID, createRecordsService({ records }));
export const handler = async (event) => {
  if (event.source === 'aws.events' && event['detail-type'] === 'Scheduled Event' && !event.requestContext) {
    await cleanupExpired();
    return { cleaned: true, at: timestamp() };
  }
  return apiHandler(event);
};

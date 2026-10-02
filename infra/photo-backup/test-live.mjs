import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

// Intended for AWS CloudShell after deployment. No AWS delete commands or Cognito account mutations.
// Lambda invocation uses the operator's IAM authority and synthesizes the verified JWT context.
// This tests backend isolation, not Cognito token signature validation or hosted login.
const region = process.env.AWS_REGION ?? 'eu-north-1';
const stack = process.env.STACK_NAME ?? 'rolling-ppl-photo-backup';
if (!/^rolling-ppl-photo-backup(?:-[a-z0-9-]+)?$/.test(stack)) throw new Error('Unexpected Rolling PPL stack name.');
const aws = (...args) => execFileSync('aws', [...args, '--region', region, '--no-cli-pager'], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AWS_PAGER: '' },
});
const outputs = Object.fromEntries(JSON.parse(aws('cloudformation', 'describe-stacks', '--stack-name', stack,
  '--query', 'Stacks[0].Outputs', '--output', 'json')).map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]));
for (const key of ['clientId', 'apiBaseUrl', 'PhotoBucketName', 'ManifestTableName']) {
  assert.equal(typeof outputs[key], 'string', `Missing deployed output: ${key}`);
}
const temporary = mkdtempSync(join(tmpdir(), 'rolling-ppl-photo-smoke-'));
const files = [];
let invocationNumber = 0;
async function invoke(user, method, path, body, claimsPatch = {}) {
  const index = ++invocationNumber;
  const payloadPath = join(temporary, `${index}-event.json`);
  const responsePath = join(temporary, `${index}-response.json`);
  files.push(payloadPath, responsePath);
  const event = { version: '2.0', rawPath: path, requestContext: { http: { method }, authorizer: { jwt: { claims: {
    sub: user, token_use: 'access', client_id: outputs.clientId, ...claimsPatch,
  } } } }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
  writeFileSync(payloadPath, JSON.stringify(event));
  const result = JSON.parse(aws('lambda', 'invoke', '--function-name', `${stack}-api`,
    '--payload', `fileb://${payloadPath}`, '--cli-binary-format', 'raw-in-base64-out', '--output', 'json', responsePath));
  assert.equal(result.FunctionError, undefined, 'Lambda invocation raised an unhandled function error.');
  const response = JSON.parse(readFileSync(responsePath, 'utf8'));
  return { status: response.statusCode, body: JSON.parse(response.body) };
}
const user = randomUUID();
const otherUser = randomUUID();
const photoId = `live-smoke-${randomUUID()}`;
// Valid one-pixel PNG: no personal image data. Its permanent fixture is 68 bytes.
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const checksumSha256 = createHash('sha256').update(bytes).digest('base64');
const now = new Date().toISOString();
const metadata = { date: now.slice(0, 10), view: 'front', mimeType: 'image/png', size: bytes.length,
  checksumSha256, width: 1, height: 1, createdAt: now };
async function upload(intent, imageBytes = bytes, fieldPatch = {}) {
  const form = new FormData();
  for (const [name, value] of Object.entries({ ...intent.fields, ...fieldPatch })) form.append(name, value);
  form.append('file', new Blob([imageBytes], { type: 'image/png' }), 'smoke.png');
  return fetch(intent.url, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
}
const pass = (message) => console.log(`PASS ${message}`);
try {
  const unauthenticated = await fetch(`${outputs.apiBaseUrl}/photos`, { signal: AbortSignal.timeout(30000) });
  assert.equal(unauthenticated.status, 401, 'Public API must reject an unauthenticated request.');
  pass('Public HTTP API rejects missing JWT (401).');

  const wrongClient = await invoke(user, 'GET', '/photos', undefined, { client_id: 'not-the-configured-client' });
  assert.equal(wrongClient.status, 401, 'Lambda must reject a foreign token client.');
  const idToken = await invoke(user, 'GET', '/photos', undefined, { token_use: 'id' });
  assert.equal(idToken.status, 401, 'Lambda must reject an ID token context.');
  const spoofedOwner = await invoke(user, 'POST', `/photos/${photoId}/upload`, { ...metadata, user: otherUser });
  assert.equal(spoofedOwner.status, 400, 'Lambda must reject identity fields in photo metadata.');
  pass('Foreign clients, ID tokens and body identity spoofing are rejected.');

  const prepare = await invoke(user, 'POST', `/photos/${photoId}/upload`, metadata);
  assert.equal(prepare.status, 200, 'Preparing the fixture upload must succeed.');
  assert.equal(prepare.body.fields.key.startsWith(`users/${user}/uploads/${photoId}/`), true, 'Staging prefix must use the caller subject.');
  const wrongMime = await upload(prepare.body, bytes, { 'Content-Type': 'image/jpeg' });
  assert.equal(wrongMime.ok, false, 'Signed POST must reject changed MIME.');
  const wrongChecksum = await upload(prepare.body, bytes, { 'x-amz-checksum-sha256': createHash('sha256').update('wrong').digest('base64') });
  assert.equal(wrongChecksum.ok, false, 'Signed POST must reject a changed checksum field.');
  const corrupt = Buffer.from(bytes); corrupt[corrupt.length - 1] ^= 1;
  const wrongBytes = await upload(prepare.body, corrupt);
  assert.equal(wrongBytes.ok, false, 'S3 must reject bytes that fail the signed SHA256 checksum.');
  const wrongSize = await upload(prepare.body, Buffer.concat([bytes, Buffer.from([0])]));
  assert.equal(wrongSize.ok, false, 'Signed POST must reject a different byte count.');
  pass('Real S3 POST rejects altered MIME, checksum, content and byte count.');

  const uploaded = await upload(prepare.body);
  assert.equal(uploaded.ok, true, `Real S3 POST must accept the valid fixture (received HTTP ${uploaded.status}).`);
  const confirmed = await invoke(user, 'POST', `/photos/${photoId}/confirm`, { uploadId: prepare.body.uploadId });
  assert.equal(confirmed.status, 200, 'S3 verification and manifest confirmation must succeed.');
  assert.equal(confirmed.body.photo.checksumSha256, checksumSha256, 'Confirmed checksum must match fixture.');
  const confirmRetry = await invoke(user, 'POST', `/photos/${photoId}/confirm`, { uploadId: prepare.body.uploadId });
  assert.equal(confirmRetry.status, 200, 'Confirmation retry must succeed idempotently.');
  pass('Real S3 upload, signature verification and idempotent confirmation succeed.');

  const listed = await invoke(user, 'GET', '/photos');
  assert.equal(listed.status, 200, 'Fixture owner must be able to list backups.');
  assert.equal(listed.body.photos.some((photo) => photo.id === photoId), true, 'Fixture must appear in owner manifest.');
  const otherList = await invoke(otherUser, 'GET', '/photos');
  assert.equal(otherList.status, 200, 'Other synthetic subject must have an isolated list.');
  assert.deepEqual(otherList.body.photos, [], 'Other subject must not see the fixture.');
  const otherDownload = await invoke(otherUser, 'GET', `/photos/${photoId}/download`);
  assert.equal(otherDownload.status, 404, 'Other subject must not obtain a signed download.');
  pass('DynamoDB manifest and signed downloads isolate two subjects.');

  const download = await invoke(user, 'GET', `/photos/${photoId}/download`);
  assert.equal(download.status, 200, 'Owner must obtain a signed download.');
  const image = await fetch(download.body.url, { signal: AbortSignal.timeout(30000) });
  assert.equal(image.ok, true, 'Signed S3 download must succeed.');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes, 'Downloaded fixture must exactly match uploaded bytes.');
  const objectKey = `users/${user}/photos/${photoId}/${prepare.body.uploadId}`;
  const tags = JSON.parse(aws('s3api', 'get-object-tagging', '--bucket', outputs.PhotoBucketName, '--key', objectKey, '--output', 'json'));
  assert.equal(tags.TagSet.some((tag) => tag.Key === 'staging'), false, 'Permanent fixture must not inherit the staging lifecycle tag.');
  const head = JSON.parse(aws('s3api', 'head-object', '--bucket', outputs.PhotoBucketName, '--key', objectKey,
    '--checksum-mode', 'ENABLED', '--output', 'json'));
  assert.equal(head.ContentLength, bytes.length, 'Permanent object size must match fixture.');
  assert.equal(head.ChecksumSHA256, checksumSha256, 'Permanent object checksum must match fixture.');
  assert.equal(head.ServerSideEncryption, 'AES256', 'Permanent object must use the expected encryption.');
  pass('Downloaded bytes, encryption, checksum and permanent lifecycle tags are correct.');
  console.log(`Retained non-personal fixture: ${photoId} (${bytes.length} bytes). Confirmation cleaned up its temporary upload copy.`);
  console.log('LIMITATION: authenticated routes used direct IAM-authorized Lambda invokes with synthetic verified JWT context.');
  console.log('Hosted Cognito login, real access-token acceptance, browser CORS and deletion require separate verification.');
} catch (error) {
  // Do not dump AWS command output, presigned form fields, credentials or download URLs.
  console.error(error instanceof assert.AssertionError ? `FAIL ${error.message}` : 'FAIL Live test encountered an AWS or network error.');
  process.exitCode = 1;
} finally {
  for (const path of files) { try { unlinkSync(path); } catch {} }
  try { rmdirSync(temporary); } catch {}
}

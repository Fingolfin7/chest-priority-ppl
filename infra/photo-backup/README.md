# Rolling PPL private photo backup

This deploys a separate Rolling PPL S3 photo bucket, DynamoDB manifest, Cognito user pool, HTTP API, ARM64 Node 22 Lambda, seven-day logs and a daily cleanup rule. `artifacts.yaml` creates a separate deployment bucket. Neither template references any existing bucket, database, Autumn service or AWS credentials. The Lambda role can access only the new photo bucket and manifest table. Photo/manifest/user-pool/artifact resources are retained on deletion or replacement.

## Deploy in AWS CloudShell

Use the signed-in AWS account and `eu-north-1`. Clone the repository/authorized branch, then run:

```bash
export APP_ORIGIN='https://YOUR-USERNAME.github.io'
export REDIRECT_URI='https://YOUR-USERNAME.github.io/chest-priority-ppl/'
export AWS_REGION='eu-north-1'
bash infra/photo-backup/deploy.sh
```

The script validates both templates, installs the isolated backend dependencies from its lockfile, runs backend tests, bundles/ZIPs the Lambda, creates a new `rolling-ppl-photo-backup-artifacts` stack, uploads its hashed code artifact, and deploys the new `rolling-ppl-photo-backup` stack with `CAPABILITY_IAM`. It prints a public frontend config object. No secret goes in the frontend. Set the PWA's public config with the exact outputs `region`, `userPoolId`, `clientId`, `authDomain`, `apiBaseUrl`, `redirectUri`.

The callback and logout URL must exactly match the PWA URL, including its base path and trailing slash. Cognito uses the Lite plan and classic hosted login. Its public client enables only the authorization code OAuth flow; the PWA uses PKCE S256, one-use state and an access token. Self-service sign-up is off by default (`SelfSignup=false`), so strangers cannot create accounts and consume storage; create your account with `aws cognito-idp admin-create-user` (or deploy with `SelfSignup=true` temporarily). Email addresses are verified by Cognito. Consider an AWS Budgets alarm, because S3 download traffic is not covered by the API rate limit. No Cognito client secret, AWS key, or privileged credential is required on the device. API Gateway validates JWT signature, issuer, audience and `openid` scope; Lambda additionally requires `token_use=access`, the expected `client_id`, and a valid Cognito `sub` from the verified authorizer context.

To change quotas explicitly, add `MaxPhotos=...` and `MaxBytes=...` to the script's main CloudFormation parameter overrides. Defaults are 500 photos and 1 GiB per user, counting both committed photos and pending reservations; each file is at most 8 MiB. Failed pending reservations expire after one hour. Daily cleanup transactionally releases their counters; quota failures also clean that user's expired reservations before retrying.

## API contract

The template applies a small CSS-only classic login customization to this app client, using the PWA's blue buttons and neutral colors. It depends on the hosted domain and uses Cognito's documented customizable classes/properties. It adds no IAM permissions, logo upload, new user account or runtime access: [classic branding documentation](https://docs.aws.amazon.com/cognito/latest/developerguide/hosted-ui-classic-branding.html), [CloudFormation attachment](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cognito-userpooluicustomizationattachment.html).

All routes require `Authorization: Bearer <Cognito access token>`. JSON errors are `{ "error": { "code": "...", "message": "..." } }`. Responses are `Cache-Control: no-store`. Photo IDs are 1–128 ASCII letters/numbers/underscore/hyphen; IDs are immutable.

| Route | Body / response |
| --- | --- |
| `GET /photos?cursor=...` | `{photos, tombstones, nextCursor?}`. Read every page before reconciling deletions. Pending records are omitted. Cursor is scoped to the authenticated user. |
| `POST /photos/{id}/upload` | Body: `{date,view,mimeType,size,checksumSha256,width,height,createdAt}`. Response: `{uploadId,url,fields,expiresAt}` or `{alreadyUploaded:true,photo}`. |
| `POST /photos/{id}/confirm` | Body: `{uploadId}`. Response: `{photo}`. Idempotent for a completed matching upload. |
| `GET /photos/{id}/download` | `{url,expiresAt,photo}`; signed GET lasts five minutes. |
| `DELETE /photos/{id}` | `{id,deletedAt}`. Idempotent; creates a tombstone even for an unknown ID. |

`photo` is `{id,date,view,mimeType,size,checksumSha256,width,height,createdAt,updatedAt}`. `tombstone` is `{id,deletedAt}`. `checksumSha256` is a canonical base64 SHA-256 of the exact uploaded Blob. MIME must be JPEG, PNG or WebP; date must be a real ISO date and view front/side/back. Dimensions describe the local metadata; the backend verifies positive bounded dimensions, image file signatures, byte size and checksum but does not decode images to verify the dimensions.

For upload, create `FormData`, append every returned `fields` entry unchanged, then append `file` **last**; POST it to `url`. Do not manually set a multipart Content-Type header. Its signed policy enforces the exact byte count, MIME, SHA-256, AES256 encryption and staging tag. Signed uploads expire after ten minutes. Confirm checks S3 HEAD size/MIME/checksum and reads the image signature, then copies into a durable key with a conditional ETag and strips the staging tag. The original signed URL can only overwrite the staging key; it cannot alter a committed photo. Staging objects expire through the bucket lifecycle after one day.

S3 keys are always constructed by the backend: `users/<Cognito sub>/uploads/<photo id>/<upload UUID>` and `users/<Cognito sub>/photos/<photo id>/<upload UUID>`. Clients never choose a user prefix, bucket, key or manifest owner. DynamoDB uses the same authenticated subject for its partition.

Cloud deletion first writes a permanent tombstone and releases quota in one DynamoDB transaction, then removes the image bytes. Delayed prepare/confirm calls receive `409 PHOTO_DELETED`. To re-add a deliberately deleted image, the device must create a new photo ID. An already-issued signed download URL expires within five minutes; deletion removes its object immediately on successful S3 removal. A failed removal leaves internal keys in the tombstone so an explicit retry can finish it. Do not enable S3 versioning without adding version-aware deletion; this template keeps it off so deleting an object removes its bytes rather than merely creating a delete marker.

## Verification

The core authorization/concurrency suite has no third-party dependencies and can run from repository root in CI:

```bash
node --test infra/photo-backup/test/*.test.mjs
```

Bundling the actual AWS handler uses the backend's isolated dependencies:

```bash
cd infra/photo-backup
npm ci
npm test
npm run build
```

Tests cover unauthorized token/client contexts, identity/path injection, metadata limits, per-user isolation, idempotent uploads, invalid image signatures, deletion tombstones, failed S3 cleanup retries, confirm/delete races and concurrent confirms. These local tests do not claim AWS integration validation. After deployment verify unauthenticated API requests return 401, then use two separate Cognito accounts to confirm upload/download/list isolation, invalid checksums fail at S3, confirmation preserves permanent objects without the staging tag, explicit deletion blocks reupload, and pending cleanup releases counters without affecting active photos. Use only disposable test photos/IDs.

An IAM-authorized AWS CloudShell operator can run `node infra/photo-backup/test-live.mjs` after deployment. This performs real signed S3 POST/download requests, verifies checksum/MIME/size rejection and permanent lifecycle tags, exercises isolated synthetic subjects through direct Lambda invocation, and checks the public HTTP API rejects a missing JWT. It retains one non-personal 68-byte PNG fixture and performs no AWS deletion or Cognito account creation. Direct Lambda calls synthesize the verified authorizer context, so this does **not** prove hosted login or acceptance of a real Cognito token. The script prints no credentials or presigned URLs.

## Billing and recovery

There is no always-running instance, provisioned Lambda concurrency, provisioned DynamoDB capacity, NAT gateway, or paid KMS key. Costs are stored S3 bytes, S3 requests/download transfer, HTTP API requests, Lambda executions, DynamoDB on-demand transactions/storage and logs. The daily cleanup incurs an on-demand table scan; sparse private use keeps it small. AWS currently provides 10,000 direct Cognito Lite monthly active users free per account/organization; service free tiers and usage in other apps share account limits. Check the selected Stockholm region and actual account usage before relying on a numeric monthly estimate: [Cognito pricing](https://aws.amazon.com/cognito/pricing/), [S3 pricing](https://aws.amazon.com/s3/pricing/), [HTTP API pricing](https://aws.amazon.com/api-gateway/pricing/), [DynamoDB pricing](https://aws.amazon.com/dynamodb/pricing/), [Lambda pricing](https://aws.amazon.com/lambda/pricing/).

Keep the exported stack outputs and account access. Retaining resources protects accidental stack deletion but does not itself provide a separate backup of images or manifests. If rebuilding a deleted stack, recover the retained Cognito user pool and manifest together: a new user pool gives a different `sub` and cannot automatically claim old photos. Existing local JSON photo exports remain useful as a separate recovery copy.

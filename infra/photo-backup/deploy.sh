#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
region="${AWS_REGION:-eu-north-1}"
stack="${STACK_NAME:-rolling-ppl-photo-backup}"
: "${APP_ORIGIN:?Set APP_ORIGIN to the PWA origin (no trailing slash)}"
: "${REDIRECT_URI:?Set REDIRECT_URI to the exact PWA callback URL including its base path}"
if [[ ! "$stack" =~ ^rolling-ppl-photo-backup(-[a-z0-9-]+)?$ ]]; then
  echo 'STACK_NAME must start with rolling-ppl-photo-backup and use lowercase letters/numbers/hyphens.' >&2
  exit 1
fi
export AWS_DEFAULT_REGION="$region"
aws cloudformation validate-template --template-body file://artifacts.yaml >/dev/null
aws cloudformation validate-template --template-body file://template.yaml >/dev/null
npm ci
npm test
npm run build
(cd dist && zip -q lambda.zip index.mjs)
aws cloudformation deploy --stack-name "$stack-artifacts" --template-file artifacts.yaml --no-fail-on-empty-changeset
code_bucket="$(aws cloudformation describe-stacks --stack-name "$stack-artifacts" --query 'Stacks[0].Outputs[?OutputKey==`CodeBucket`].OutputValue' --output text)"
code_hash="$(sha256sum dist/lambda.zip | cut -d' ' -f1)"
code_key="photo-backup/$code_hash.zip"
aws s3 cp dist/lambda.zip "s3://$code_bucket/$code_key" --sse AES256 --only-show-errors
aws cloudformation deploy --stack-name "$stack" --template-file template.yaml --capabilities CAPABILITY_IAM \
  --parameter-overrides "AppOrigin=$APP_ORIGIN" "RedirectUri=$REDIRECT_URI" "CodeBucket=$code_bucket" "CodeKey=$code_key" \
  --no-fail-on-empty-changeset
aws cloudformation describe-stacks --stack-name "$stack" --query 'Stacks[0].Outputs' --output json > deployment-outputs.json
node --input-type=module -e 'import fs from "node:fs"; const all = Object.fromEntries(JSON.parse(fs.readFileSync("deployment-outputs.json")).map(x => [x.OutputKey,x.OutputValue])); console.log(JSON.stringify(Object.fromEntries(["region","userPoolId","clientId","authDomain","apiBaseUrl","redirectUri"].map(k => [k,all[k]])),null,2));'

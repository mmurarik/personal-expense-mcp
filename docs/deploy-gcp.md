# Deploy V0 on Google Cloud

Use these commands after the local checks pass. This runbook assumes Bash, Google Cloud CLI, Cloud SQL Auth Proxy v2, `psql`, and Node 22. Run from the repository root. Choose a project with billing enabled and set a budget alert in **Billing → Budgets & alerts**. Cloud SQL incurs charges while provisioned, including when Cloud Run scales to zero.

## 1. Provision the project resources

Sign in with `gcloud auth login` and set these variables in the deployment shell. Use a new release tag on each deployment.

```bash
export EXPENSES_PROJECT="YOUR_PROJECT_ID"
export EXPENSES_REGION="us-central1"
export EXPENSES_INSTANCE="$EXPENSES_PROJECT:$EXPENSES_REGION:expenses-db"
export EXPENSES_SA="expenses-runtime@$EXPENSES_PROJECT.iam.gserviceaccount.com"
export EXPENSES_IMAGE="$EXPENSES_REGION-docker.pkg.dev/$EXPENSES_PROJECT/expenses/expense-service:v0"
export CLOUDSDK_CORE_PROJECT="$EXPENSES_PROJECT"

gcloud services enable run.googleapis.com sqladmin.googleapis.com \
  secretmanager.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com \
  logging.googleapis.com

gcloud artifacts repositories create expenses \
  --repository-format=docker --location="$EXPENSES_REGION" --immutable-tags

gcloud sql instances create expenses-db \
  --database-version=POSTGRES_16 --edition=enterprise --tier=db-f1-micro \
  --region="$EXPENSES_REGION" --availability-type=zonal --assign-ip \
  --storage-size=10 --backup-start-time=09:00 --deletion-protection
```

If you are resuming a deployment, check the existing instance before running the creation command again. The same read-only check also verifies a new instance.

```bash
gcloud sql instances describe expenses-db \
  --project="$EXPENSES_PROJECT" \
  --format='yaml(name,state,region,databaseVersion,settings.edition,settings.tier,settings.availabilityType,settings.dataDiskSizeGb,settings.ipConfiguration,settings.backupConfiguration.enabled,settings.backupConfiguration.startTime,settings.deletionProtectionEnabled)'
```

Confirm `state: RUNNABLE`, PostgreSQL 16, Enterprise edition, `db-f1-micro`, zonal availability, and 10 GB of storage for a new instance. Verify that IPv4 is enabled, the authorized networks list is empty or absent, backups are enabled with a 09:00 UTC start time, and deletion protection is enabled.

Create the identity that the expense service will use at runtime, then grant it permission to connect through the Cloud SQL connector. The PostgreSQL login is set up separately in the next section.

```bash
gcloud iam service-accounts create expenses-runtime
gcloud projects add-iam-policy-binding "$EXPENSES_PROJECT" \
  --member="serviceAccount:$EXPENSES_SA" --role=roles/cloudsql.client
```

The SQL instance has a public IP for the managed connector. Leave **Authorized networks** empty. The provisioner needs rights to enable APIs, create infrastructure and grant IAM. Separately, the release deployer needs Cloud Build submission and Cloud Run deployment permissions (including the invoker IAM setting), plus `roles/iam.serviceAccountUser` scoped to `expenses-runtime`. Use `gcloud builds get-default-service-account --region="$EXPENSES_REGION"` to identify the build service account. Give that identity Artifact Registry Writer on the `expenses` repository and grant access to read the staged source and write build logs in the regional buckets. Keep those grants off the runtime account. [Cloud Build service accounts](https://docs.cloud.google.com/build/docs/cloud-build-service-account) · [Cloud SQL instance creation](https://docs.cloud.google.com/sql/docs/postgres/create-instance)

## 2. Set up the database login and secrets

Set the initial `postgres` administrator password in the Cloud SQL console. In a separate terminal with the same project settings, start the Auth Proxy using a Google identity with Cloud SQL Client permission.

```bash
gcloud auth application-default login
cloud-sql-proxy --address 127.0.0.1 --port 15432 "$EXPENSES_INSTANCE"
```

Connect in the deployment shell. Generate a password for `expenses_app` using a password manager. Paste it into the prompts from `\password`, which avoids putting a cleartext password in SQL history. The temporary grant allows the administrator to assign database ownership to the application role. Database ownership gives that role the privileges it needs to migrate and use this database.

```bash
psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 15432 -U postgres -d postgres
```

```sql
CREATE ROLE expenses_app LOGIN;
\password expenses_app
GRANT expenses_app TO postgres;
CREATE DATABASE expenses OWNER expenses_app;
REVOKE expenses_app FROM postgres;
\q
```

Stop the Auth Proxy with Ctrl+C. In the deployment shell, with tracing disabled, paste the same application password at the hidden prompt. The token is generated from 32 random bytes and streamed directly into Secret Manager.

```bash
set +x
read -rs -p "expenses_app database password: " EXPENSES_DB_PASSWORD; printf '\n'
printf '%s' "$EXPENSES_DB_PASSWORD" | gcloud secrets create expenses-db-password \
  --replication-policy=user-managed --locations="$EXPENSES_REGION" --data-file=-
unset EXPENSES_DB_PASSWORD
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' \
  | gcloud secrets create expenses-api-token --replication-policy=user-managed \
      --locations="$EXPENSES_REGION" --data-file=-

for secret in expenses-db-password expenses-api-token; do
  gcloud secrets add-iam-policy-binding "$secret" \
    --member="serviceAccount:$EXPENSES_SA" --role=roles/secretmanager.secretAccessor
done
```

Give the owner read access to the API token secret for client setup. The app reads both pinned secret versions through its runtime identity. [Cloud SQL Auth Proxy](https://docs.cloud.google.com/sql/docs/postgres/connect-auth-proxy) · [Cloud Run and Cloud SQL socket configuration](https://docs.cloud.google.com/sql/docs/postgres/connect-run)

## 3. Build and run the migration job

Cloud Build uploads the paths allowed by `.gcloudignore`. The image contains both executables and the committed migrations. Stop before deploying the web service if either job execution fails. The second execution verifies a clean rerun.

```bash
gcloud builds submit --region="$EXPENSES_REGION" \
  --default-buckets-behavior=regional-user-owned-bucket --tag "$EXPENSES_IMAGE" .

gcloud run jobs deploy expenses-migrate \
  --image="$EXPENSES_IMAGE" --region="$EXPENSES_REGION" \
  --service-account="$EXPENSES_SA" --set-cloudsql-instances="$EXPENSES_INSTANCE" \
  --set-env-vars="PGHOST=/cloudsql/$EXPENSES_INSTANCE,PGDATABASE=expenses,PGUSER=expenses_app" \
  --set-secrets="PGPASSWORD=expenses-db-password:1" \
  --command=node --args=dist/db/migrate.js --tasks=1 --max-retries=0

gcloud run jobs execute expenses-migrate --region="$EXPENSES_REGION" --wait
gcloud run jobs execute expenses-migrate --region="$EXPENSES_REGION" --wait
```

## 4. Deploy the HTTPS service

Cloud Run generates request logs that can include request URLs. Exclude the service's platform request logs from retained log sinks before sending personal data because list filters travel in the URL. The following first-time rule targets only this service's platform request logs in the default project sink. Apply the same exclusion to any other sink that routes them. Application logs still record route, tool, status, and duration.

```bash
gcloud logging sinks update _Default \
  --add-exclusion='name=expenses-platform-requests,filter=resource.type="cloud_run_revision" AND resource.labels.service_name="expenses" AND log_id("run.googleapis.com/requests")'

gcloud run deploy expenses \
  --image="$EXPENSES_IMAGE" --region="$EXPENSES_REGION" \
  --service-account="$EXPENSES_SA" --execution-environment=gen2 \
  --no-invoker-iam-check --set-cloudsql-instances="$EXPENSES_INSTANCE" \
  --set-env-vars="PGHOST=/cloudsql/$EXPENSES_INSTANCE,PGDATABASE=expenses,PGUSER=expenses_app,OWNER_TIMEZONE=America/Los_Angeles" \
  --set-secrets="PGPASSWORD=expenses-db-password:1,API_BEARER_TOKEN=expenses-api-token:1" \
  --port=8080 --min=0 --max=2 --concurrency=20

export BASE_URL="$(gcloud run services describe expenses --region="$EXPENSES_REGION" --format='value(status.url)')"
printf '%s\n' "$BASE_URL"
```

Cloud Run accepts internet traffic. Fastify enforces bearer authentication on all data routes and `/mcp`. Confirm the project policy permits disabling the invoker IAM check. The service derives the loopback REST origin from `PORT`. [Cloud Run public access](https://docs.cloud.google.com/run/docs/authenticating/public) · [Cloud Run logs and exclusions](https://docs.cloud.google.com/run/docs/logging)

## 5. Verify before connecting Claude

Load the pinned token into the current shell without printing it. Run this synthetic REST check. Repeat it with a fresh tag after each release.

```bash
set +x
export EXPENSES_API_TOKEN="$(gcloud secrets versions access 1 --secret=expenses-api-token)"

node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { BASE_URL, EXPENSES_API_TOKEN } = process.env;
assert.ok(BASE_URL && EXPENSES_API_TOKEN);
const auth = { Authorization: `Bearer ${EXPENSES_API_TOKEN}` };
async function check(path, status, options = {}) {
  const res = await fetch(new URL(path, BASE_URL), options);
  assert.equal(res.status, status, `${options.method ?? 'GET'} ${path}`);
  if (res.headers.get('content-type')?.includes('application/json')) return res.json();
  await res.text();
}
const path = '/v1/expenses';
await check('/healthz', 200);
await check('/readyz', 401);
await check('/readyz', 200, { headers: auth });
await check(path, 401);
await check('/mcp', 401, { method: 'POST' });
const headers = { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() };
const body = JSON.stringify({ amount_minor: 1250, merchant: 'Corner Cafe', category: 'dining', expense_date: '2026-11-02' });
const created = await check(path, 201, { method: 'POST', headers, body });
assert.deepEqual(await check(path, 200, { method: 'POST', headers, body }), created);
const item = `${path}/${created.id}`;
assert.deepEqual(await check(item, 200, { headers: auth }), created);
assert.ok((await check(`${path}?category=dining&merchant=Corner%20Cafe`, 200, { headers: auth })).items.some(({ id }) => id === created.id));
const updated = await check(item, 200, { method: 'PATCH', headers, body: JSON.stringify({ expected_version: created.version, category: 'groceries' }) });
assert.equal(updated.version, created.version + 1);
await check(item, 409, { method: 'PATCH', headers, body: JSON.stringify({ expected_version: created.version, category: 'other' }) });
for (let run = 0; run < 2; run++) {
  await check(`${item}?expected_version=${updated.version}`, 204, { method: 'DELETE', headers: auth });
}
await check(item, 404, { headers: auth });
console.log('Deployed REST smoke passed.');
JS
```

Continue with [Claude setup and the live acceptance demo](claude-setup.md). For later releases, build a new immutable tag, run migrations compatible with the previous revision, deploy, then repeat the smoke tests. To rotate the token, add a new Secret Manager version, deploy a revision pinned to that version, and update the private client header. Use the actual pinned versions in the job and service commands.

# Personal Expense API and MCP Server

A single-owner USD expense service. An MCP client calls one of five tools over HTTP. Each tool calls the REST API on the same service. The API validates the input and uses PostgreSQL to store or retrieve the record.

**Deployed URL** · Pending Cloud Run deployment. After deployment, record the HTTPS service origin here. The remote connector URL is `BASE_URL/mcp`. The owner obtains the pinned API token from Secret Manager's `expenses-api-token` secret.

## Run the five-minute local demo

Use Node.js 22 and npm. If you already use nvm, run `nvm use` first. From the repository root, run the following as a regular user. The embedded PostgreSQL package starts a real PostgreSQL 16 server on a temporary loopback port.

```bash
npm ci
npm run demo
```

The demo applies the migrations twice, connects an official MCP SDK client, and discovers five tools. It saves a synthetic $12.50 Corner Cafe expense, retries creation with the same UUID, finds one record in a filtered list, and reads it again after an app restart and fresh client connection. It updates the category, deletes the record, and repeats deletion. The script cleans up its temporary database.

## Verify or run against your own local PostgreSQL

```bash
npm run typecheck
npm test
npm run build
npm run openapi
npm run db:generate
```

The tests use disposable PostgreSQL, Fastify's in-process HTTP test interface for REST, and the official MCP client over a real HTTP listener. `db:generate` should report no changes for the current schema. OpenAPI is generated at [openapi.json](openapi.json).


Local verification passed on Node 22 and PostgreSQL 16, including all 31 integration tests, the full SDK-client demo, and Claude Code's connection check against the compiled server. The Docker image built successfully in Google Cloud Shell. Live Cloud Run and a Claude conversation using the deployed connector are pending.

For an interactive run, create a local PostgreSQL database named `expenses` owned by your `expenses_app` login. Copy `.env.example` to `.env`, fill in your local database password, and set `API_BEARER_TOKEN` to a value generated with `openssl rand -hex 32`. Then run these from the repository root.

```bash
npm run build
node --env-file=.env dist/db/migrate.js
node --env-file=.env dist/server.js
```

From a second terminal, send the REST equivalent of a confirmed `create_expense` tool call. This request uses the local token from `.env` and generates a fresh idempotency key.

```bash
node --env-file=.env --input-type=module <<'JS'
import { randomUUID } from 'node:crypto';

const response = await fetch(`http://127.0.0.1:${process.env.PORT ?? 8080}/v1/expenses`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.API_BEARER_TOKEN}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': randomUUID()
  },
  body: JSON.stringify({
    amount_minor: 1250,
    merchant: 'Corner Cafe',
    expense_date: '2026-11-02',
    category: 'dining'
  })
});
console.log(response.status, await response.json());
JS
```

Expect HTTP 201 and an expense UUID at version 1. `1250` is $12.50, and the omitted notes become null. If a create request times out, send the same body and idempotency key to retrieve its original receipt. To see the current record, read by expense UUID.

## Read the code in request order

1. [Server](src/server.ts) and [authentication](src/auth.ts) show how the service starts and checks the bearer token.
2. [MCP tools](src/mcp.ts) translate a tool call into a REST request. A create tool's `request_id` becomes the REST `Idempotency-Key`.
3. [REST routes](src/expense-routes.ts) and [shared validation](src/schemas.ts) check the shapes of requests, similar to validating data before an Alteryx workflow loads it.
4. [Expense service](src/expense-service.ts) owns database reads, writes, and transactions. A version check prevents someone editing an older copy from overwriting a newer record, as with a stale CRM edit.
5. [Database tables](src/db/schema.ts) and [initial migration](drizzle/0000_init.sql) define the stored records and the separate table of create receipts.
6. [REST tests](test/api.test.ts) and [MCP tests](test/mcp.test.ts) show concrete examples of the happy paths and failure cases.

## Deploy and connect a client

- [Google Cloud provisioning, migration, deployment, and REST smoke test](docs/deploy-gcp.md)
- [Claude web, Desktop, and Claude Code setup with the live demo](docs/claude-setup.md)
- [V0 specification and deployed acceptance criteria](Personal%20Expense%20API%20and%20MCP%20Server%20V0%20Specification.md)

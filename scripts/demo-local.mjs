import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer } from "../dist/server.js";
import { loadAppConfig } from "../dist/config.js";
import { freePort, startDisposablePostgres } from "./disposable-postgres.mjs";

const cluster = await startDisposablePostgres();
let app;
let client;
let base;
try {
  const token = randomBytes(32).toString("hex");
  const headers = { Authorization: `Bearer ${token}` };
  const env = {
    ...process.env,
    PGHOST: cluster.db.host,
    PGPORT: String(cluster.db.port),
    PGDATABASE: cluster.db.database,
    PGUSER: cluster.db.user,
    PGPASSWORD: cluster.db.password,
  };

  for (let run = 0; run < 2; run++) {
    const migration = spawn(process.execPath, ["dist/db/migrate.js"], { env, stdio: "inherit" });
    const [code] = await once(migration, "exit");
    assert.equal(code, 0, "Migration must succeed.");
  }

  async function connect() {
    // A fresh port also gives the restarted service fresh HTTP connections.
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    app = createServer(loadAppConfig({
      ...env, PORT: String(port), API_INTERNAL_BASE_URL: base, API_BEARER_TOKEN: token,
      OWNER_TIMEZONE: "America/Los_Angeles",
    }));
    await app.listen({ host: "127.0.0.1", port });
    client = new Client({ name: "expense-demo", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
  }

  async function call(name, args) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, false, JSON.stringify(result.content));
    return result.structuredContent;
  }

  await connect();
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/readyz`, { headers })).status, 200);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 5);
  console.log("Discovered", tools.map(({ name }) => name).join(", "));

  const proposal = {
    request_id: randomUUID(),
    amount_minor: 1250,
    merchant: "Corner Cafe",
    expense_date: "2026-11-02",
    category: "dining",
  };
  const original = await call("create_expense", proposal);
  console.log("Created synthetic $12.50 expense", original.id, "at version", original.version);
  assert.deepEqual(await call("create_expense", proposal), original);

  const page = await call("list_expenses", { category: "dining", merchant: "corner" });
  assert.deepEqual(page.items, [original]);
  console.log("Found one filtered result after retrying the same create.");

  await client.close();
  await app.close();
  await connect();
  const expense_id = original.id;
  assert.deepEqual(await call("get_expense", { expense_id }), original);
  console.log("Read the same expense after restarting the app and reconnecting.");

  const updated = await call("update_expense", {
    expense_id, expected_version: original.version, changes: { category: "groceries" },
  });
  assert.equal(updated.version, 2);
  assert.equal(updated.category, "groceries");
  console.log("Updated the category to groceries at version", updated.version);

  const removal = { expense_id, expected_version: updated.version };
  assert.deepEqual(await call("delete_expense", removal), { deleted: true, expense_id });
  assert.deepEqual(await call("delete_expense", removal), { deleted: true, expense_id });
  assert.deepEqual(await call("list_expenses", {}), { items: [], next_cursor: null });
  console.log("Deleted the expense, repeated the delete safely, and confirmed the list is empty.");
} finally {
  try {
    await client?.close();
    await app?.close();
  } finally {
    await cluster.stop();
  }
}

import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freePort } from "../scripts/disposable-postgres.mjs";
import { createServer } from "../src/server.js";
import { Expense, ListResult } from "../src/schemas.js";
import { authorization, config, resetExpenses, token } from "./helpers.js";

let app: ReturnType<typeof createServer>;
let base: string;
let client: Client;
let logs: string;
const connect = async () => {
  const instance = new Client({ name: "integration-test", version: "1.0.0" });
  await instance.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization } },
  }));
  return instance;
};
const start = async (databasePort?: number) => {
  const port = await freePort();
  const settings = config(port);
  if (databasePort !== undefined) settings.db.port = databasePort;
  const stream = new Writable({ write(chunk, _encoding, done) { logs += String(chunk); done(); } });
  app = createServer(settings, stream);
  base = await app.listen({ host: "127.0.0.1", port });
  client = await connect();
};
const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

const expectToolError = (result: Awaited<ReturnType<typeof call>>, code: string) => {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  const [content] = result.content as { type: string; text: string }[];
  expect(content?.type).toBe("text");
  expect(JSON.parse(content!.text)).toMatchObject({ error: { code, message: expect.any(String) } });
};

beforeEach(async () => {
  logs = "";
  await resetExpenses();
});
afterEach(async () => {
  await client?.close();
  await app?.close();
});

describe("MCP over real Streamable HTTP", () => {
  it("authenticates initialization, discovery, and calls on the exact path", async () => {
    await start();
    for (const headers of [{}, { authorization: "Bearer incorrect" }] as Record<string, string>[]) {
      for (const [method, params] of [
        ["initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } }],
        ["tools/list", {}],
        ["tools/call", { name: "list_expenses", arguments: {} }],
      ]) {
        const response = await fetch(`${base}/mcp`, {
          method: "POST", redirect: "manual",
          headers: { ...headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
      }
      for (const method of ["GET", "DELETE", "OPTIONS"]) {
        expect((await fetch(`${base}/mcp`, { method, headers })).status).toBe(401);
      }
    }
    const browser = await fetch(`${base}/mcp`, {
      method: "POST", headers: { authorization, Origin: "https://untrusted.example" },
    });
    expect(browser.status).toBe(403);
    expect(await browser.json()).toMatchObject({ error: { code: "origin_not_allowed" } });
    const initialized = await fetch(`${base}/mcp`, {
      method: "POST", redirect: "manual",
      headers: { authorization, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" },
      } }),
    });
    expect(initialized.status).toBe(200);
    expect(initialized.headers.has("mcp-session-id")).toBe(false);
    expect(await initialized.json()).toMatchObject({ result: { capabilities: { tools: {} } } });
  });

  it("advertises exactly five tools with strict input and output schemas and annotations", async () => {
    await start();
    const { tools } = await client.listTools();
    expect(tools.map(({ name }) => name)).toEqual(["create_expense", "list_expenses", "get_expense", "update_expense", "delete_expense"]);
    for (const tool of tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.outputSchema?.additionalProperties).toBe(false);
    }
    const [create, list, get, update, remove] = tools;
    expect(create?.inputSchema).toMatchObject({
      required: expect.arrayContaining(["amount_minor", "request_id"]),
      properties: {
        amount_minor: { type: "integer", minimum: 1, maximum: 1_000_000_000 },
        category: { anyOf: [{ enum: expect.arrayContaining(["dining", "groceries"]) }, { type: "null" }] },
      },
    });
    expect(update?.inputSchema.properties?.changes).toMatchObject({ additionalProperties: false });
    expect(list?.annotations?.readOnlyHint).toBe(true);
    expect(get?.annotations?.readOnlyHint).toBe(true);
    expect(remove?.annotations?.destructiveHint).toBe(true);
    expect(JSON.stringify(tools)).not.toContain(token);
  });

  it("calls all tools, persists across a new connection and server restart, and preserves error codes", async () => {
    await start();
    const request_id = randomUUID();
    const proposed = { request_id, amount_minor: 1250, merchant: "Corner Cafe", category: "dining", expense_date: "2026-11-02", notes: "MCP_PRIVATE_NOTES" };
    const result = await call("create_expense", proposed);
    expect(result.isError).toBe(false);
    const original = Expense.parse(result.structuredContent);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(original) }]);
    expect(original).toMatchObject({ amount_minor: 1250, version: 1, currency: "USD" });
    const expense_id = original.id;
    const listed = await call("list_expenses", { category: "dining", merchant: "corner", date_from: "2026-11-02", limit: 1 });
    expect(ListResult.parse(listed.structuredContent)).toEqual({ items: [original], next_cursor: null });
    await client.close();
    await app.close();
    await start();
    await client.listTools();
    expect((await call("get_expense", { expense_id })).structuredContent).toEqual(original);
    const changed = await call("update_expense", { expense_id, expected_version: 1, changes: { category: "groceries", notes: null } });
    expect(changed.structuredContent).toMatchObject({ id: expense_id, version: 2, category: "groceries", notes: null, merchant: "Corner Cafe" });
    const stale = await call("update_expense", { expense_id, expected_version: 1, changes: { amount_minor: 100 } });
    expectToolError(stale, "version_conflict");
    expect((await call("get_expense", { expense_id })).structuredContent).toEqual(changed.structuredContent);
    const deleted = await call("delete_expense", { expense_id, expected_version: 2 });
    expect(deleted.structuredContent).toEqual({ deleted: true, expense_id });
    expect((await call("delete_expense", { expense_id, expected_version: 2 })).structuredContent).toEqual(deleted.structuredContent);
    expectToolError(await call("get_expense", { expense_id }), "expense_not_found");
    expect((await call("list_expenses", {})).structuredContent).toEqual({ items: [], next_cursor: null });
    expect((await call("create_expense", proposed)).structuredContent).toEqual(original);
    expectToolError(await call("create_expense", { ...proposed, amount_minor: 42 }), "idempotency_conflict");
    const incomplete = await call("create_expense", { request_id: randomUUID(), amount_minor: 100 });
    expect((await call("get_expense", { expense_id: Expense.parse(incomplete.structuredContent).id })).structuredContent).toMatchObject({
      expense_date: null, category: null, merchant: null, notes: null,
    });
    expect(logs).not.toContain(token);
    expect(logs).not.toContain("MCP_PRIVATE_NOTES");
    expect(logs).toContain('"tool":"update_expense"');
  });

  it("rejects invalid tool input and exposes a REST cursor failure as a tool error", async () => {
    await start();
    const id = randomUUID();
    for (const [name, args] of [
      ["create_expense", { request_id: id, amount_minor: "100" }],
      ["update_expense", { expense_id: id, expected_version: 1, changes: {} }],
      ["update_expense", { expense_id: id, expected_version: 1, changes: { notes: null, id } }],
      ["get_expense", { expense_id: id, token: "unused" }],
      ["list_expenses", { cursor: "malformed" }],
    ] as const) {
      expectToolError(await call(name, args), "validation_error");
    }
  });

  it("reports PostgreSQL unavailability in readiness, REST reads/writes, and MCP writes", async () => {
    await start(await freePort());
    expect((await app.inject("/health")).statusCode).toBe(200);
    const routes = [
      { url: "/readyz" },
      { url: "/v1/expenses" },
      { method: "POST", url: "/v1/expenses", payload: { amount_minor: 100 } },
    ] as const;
    for (const route of routes) {
      const response = await app.inject({ ...route, headers: { authorization, "idempotency-key": randomUUID() } });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: { code: "database_unavailable", message: "Database is unavailable." } });
    }
    expectToolError(await call("create_expense", { request_id: randomUUID(), amount_minor: 100 }), "database_unavailable");
  });
});

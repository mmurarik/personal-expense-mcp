import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import type { InjectOptions } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "../src/db/client.js";
import { createServer } from "../src/server.js";
import type { Expense, ListResult } from "../src/schemas.js";
import { authorization, config, quiet, resetExpenses, token } from "./helpers.js";

const base = "/v1/expenses";
const app = createServer(config(), quiet);
const send = ({ headers, ...options }: InjectOptions) =>
  app.inject({ ...options, headers: { authorization, ...headers } });
const create = (payload: object = { amount_minor: 1250 }, key: string = randomUUID()) =>
  send({ method: "POST", url: base, headers: { "idempotency-key": key }, payload });

beforeEach(resetExpenses);
afterAll(() => app.close());

describe("REST API", () => {
  it("serves public liveness and protects readiness and all five expense operations", async () => {
    expect((await app.inject("/healthz")).json()).toEqual({ status: "ok" });
    expect((await send({ url: "/readyz" })).json()).toEqual({ status: "ok" });
    const item = `${base}/${randomUUID()}`;
    const operations = [
      { method: "GET", url: "/readyz" },
      { method: "POST", url: base, headers: { "content-type": "application/json" }, payload: "invalid JSON" },
      { method: "GET", url: base },
      { method: "GET", url: item },
      { method: "PATCH", url: item, payload: {} },
      { method: "DELETE", url: item },
    ] as const;
    for (const operation of operations) {
      for (const credential of [undefined, "Bearer bad-token"]) {
        const response = await app.inject({ ...operation, headers: { ...("headers" in operation ? operation.headers : {}), ...(credential && { authorization: credential }) } });
        expect(response.statusCode).toBe(401);
        expect(response.headers["www-authenticate"]).toBe("Bearer");
        expect(response.json().error.code).toBe("unauthorized");
      }
    }
  });

  it("creates, reads, filters, updates, and soft deletes with stable versions and timestamps", async () => {
    const created = await create({
      amount_minor: 1250, merchant: "  Corner Cafe  ", category: "dining",
      expense_date: "2026-11-02", notes: "Synthetic record",
    });
    expect(created.statusCode).toBe(201);
    const original = created.json<Expense>();
    const url = `${base}/${original.id}`;
    expect(created.headers.location).toBe(url);
    expect(original).toMatchObject({ amount_minor: 1250, merchant: "Corner Cafe", currency: "USD", version: 1 });
    expect((await send({ url })).json()).toEqual(original);
    const found = await send({ url: `${base}?merchant=CORNER&category=dining&date_from=2026-11-02&date_to=2026-11-02` });
    expect(found.json()).toEqual({ items: [original], next_cursor: null });

    const update = (payload: object) => send({ method: "PATCH", url, payload });
    const changed = await update({ expected_version: 1, category: "groceries", notes: null });
    expect(changed.statusCode).toBe(200);
    const updated = changed.json<Expense>();
    expect(updated).toEqual({ ...original, notes: null, category: "groceries", version: 2, updated_at: updated.updated_at });
    expect(updated.updated_at > original.updated_at).toBe(true);
    expect((await update({ expected_version: 1, merchant: "Stale" })).json().error.code).toBe("version_conflict");
    expect((await send({ url })).json()).toEqual(updated);

    const remove = (version: number) => send({ method: "DELETE", url: `${url}?expected_version=${version}` });
    expect((await remove(1)).statusCode).toBe(409);
    expect((await remove(2)).body).toBe("");
    expect((await remove(1)).statusCode).toBe(204);
    expect((await send({ url })).statusCode).toBe(404);
    expect((await update({ expected_version: 3, notes: "Hidden" })).statusCode).toBe(404);
    expect((await send({ url: base })).json()).toEqual({ items: [], next_cursor: null });
    expect((await send({ method: "DELETE", url: `${base}/${randomUUID()}?expected_version=1` })).statusCode).toBe(404);
    const pool = createPool(config().db);
    try {
      const { rows } = await pool.query("SELECT version, updated_at, deleted_at FROM expenses WHERE id = $1", [original.id]);
      expect(rows[0]).toMatchObject({ version: 3, deleted_at: rows[0].updated_at });
      expect(rows[0].deleted_at.toISOString() > updated.updated_at).toBe(true);
    } finally {
      await pool.end();
    }
  });

  it("normalizes omitted, null, and empty values and returns the original receipt after mutation", async () => {
    const key = randomUUID();
    const first = await create({ amount_minor: 1250, merchant: " ", expense_date: "", notes: "   ", category: "" }, key);
    expect(first.statusCode).toBe(201);
    const original = first.json<Expense>();
    expect(original).toMatchObject({ merchant: null, notes: null, category: null, expense_date: null });
    const url = first.headers.location as string;
    expect((await send({ url })).json()).toEqual(original);
    expect((await send({ method: "DELETE", url: `${url}?expected_version=1` })).statusCode).toBe(204);
    const replay = await create({ notes: null, amount_minor: 1250, currency: "USD" }, key.toUpperCase());
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(replay.json()).toEqual(original);
    expect((await create({ amount_minor: 1251 }, key)).json().error.code).toBe("idempotency_conflict");
  });

  it("commits one expense and one receipt for concurrent identical creates", async () => {
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 8 }, () => create({ amount_minor: 7 }, key)));
    expect(results.map(({ statusCode }) => statusCode).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
    for (const response of results) expect(response.json()).toEqual(results[0]!.json());
    const pool = createPool(config().db);
    try {
      const { rows } = await pool.query("SELECT (SELECT count(*)::int FROM expenses) AS expenses, (SELECT count(*)::int FROM expense_create_requests) AS receipts");
      expect(rows[0]).toEqual({ expenses: 1, receipts: 1 });
    } finally {
      await pool.end();
    }
  });

  it("rejects the loser when different create bodies race on a key", async () => {
    const key = randomUUID();
    const results = await Promise.all([create({ amount_minor: 1 }, key), create({ amount_minor: 2 }, key)]);
    expect(results.map(({ statusCode }) => statusCode).sort()).toEqual([201, 409]);
    expect(results.find(({ statusCode }) => statusCode === 409)?.json().error.code).toBe("idempotency_conflict");
    expect((await send({ url: base })).json<ListResult>().items).toHaveLength(1);
  });

  it("allows only one concurrent update from the same version", async () => {
    const created = await create();
    const url = created.headers.location as string;
    const results = await Promise.all(["First", "Second"].map((notes) =>
      send({ method: "PATCH", url, payload: { expected_version: 1, notes } })));
    expect(results.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
    expect((await send({ url })).json()).toEqual(results.find(({ statusCode }) => statusCode === 200)?.json());
  });

  it("serializes concurrent delete and patch, and increments only the winning version", async () => {
    const created = await create();
    const url = created.headers.location as string;
    const [update, remove] = await Promise.all([
      send({ method: "PATCH", url, payload: { expected_version: 1, notes: "Race" } }),
      send({ method: "DELETE", url: `${url}?expected_version=1` }),
    ]);
    if (remove.statusCode === 204) {
      expect(update.statusCode).toBe(404);
    } else {
      expect(remove.statusCode).toBe(409);
      expect(update.statusCode).toBe(200);
      expect(update.json().version).toBe(2);
    }
  });

  it.each([0, -1, 1.25, true, "1250", null, 1_000_000_001])("rejects invalid amount %j", async (amount_minor) => {
    const response = await create({ amount_minor });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toMatchObject({ code: "validation_error", field: "amount_minor" });
  });

  it.each([
    { currency: "EUR" }, { currency: null }, { expense_date: "2026-02-29" }, { expense_date: "0000-01-01" },
    { category: "gas" }, { unexpected: "value" }, { merchant: "a".repeat(201) }, { notes: "bad\0text" },
  ])("rejects invalid creation fields %j", async (body) => {
    expect((await create({ amount_minor: 1, ...body })).statusCode).toBe(422);
  });

  it("validates the idempotency key, JSON syntax, UUID path, query shape, and updates", async () => {
    expect((await send({ method: "POST", url: base, payload: { amount_minor: 1 } })).statusCode).toBe(422);
    expect((await create({ amount_minor: 1 }, "invalid")).statusCode).toBe(422);
    const malformed = await send({ method: "POST", url: base, headers: { "content-type": "application/json" }, payload: "{!" });
    expect(malformed.statusCode).toBe(422);
    expect((await send({ url: `${base}/not-a-uuid` })).statusCode).toBe(422);
    const url = (await create({ amount_minor: 1, expense_date: "0001-01-01" })).headers.location as string;
    expect((await send({ url })).json().expense_date).toBe("0001-01-01");
    expect((await send({ url: `${url}?unknown=1` })).statusCode).toBe(422);
    for (const payload of [
      {}, { expected_version: 1 }, { expected_version: 1, amount_minor: null }, { expected_version: 1, currency: null },
      { expected_version: 1, id: randomUUID() }, { expected_version: "1", notes: null },
    ]) {
      expect((await send({ method: "PATCH", url, payload })).statusCode).toBe(422);
    }
    for (const query of ["", "?expected_version=0", "?expected_version=1.5", "?expected_version=1&x=1"]) {
      expect((await send({ method: "DELETE", url: url + query })).statusCode).toBe(422);
    }
  });

  it("uses literal merchant matching and excludes undated expenses when filtering by date", async () => {
    const exact = (await create({ amount_minor: 1, merchant: "Cafe %_\\", expense_date: "2026-11-02" })).json<Expense>();
    await create({ amount_minor: 2, merchant: "Cafe abc", expense_date: "2026-11-01" });
    await create({ amount_minor: 3, merchant: "Cafe %_\\" });
    const filters = new URLSearchParams({ merchant: "%_\\", date_from: "2026-11-02" });
    expect((await send({ url: `${base}?${filters}` })).json()).toEqual({ items: [exact], next_cursor: null });
  });

  it("pages without duplicates across both timestamp precision and UUID ties", async () => {
    const items = await Promise.all(Array.from({ length: 6 }, () => create({ amount_minor: 7, category: "dining" })));
    const ids = items.map((response) => response.json<Expense>().id).sort().reverse();
    const pool = createPool(config().db);
    try {
      await pool.query("UPDATE expenses SET created_at = '2026-11-02 15:00:00.123456+00'");
      await pool.query("UPDATE expenses SET created_at = '2026-11-02 15:00:00.123457+00' WHERE id = $1", [ids.at(-1)]);
    } finally {
      await pool.end();
    }
    const expected = [ids.at(-1), ...ids.slice(0, -1)];
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < expected.length; i++) {
      const result = await send({ url: `${base}?category=dining&limit=1${cursor ? `&cursor=${cursor}` : ""}` });
      expect(result.statusCode).toBe(200);
      const page = result.json<ListResult>();
      seen.push(...page.items.map(({ id }) => id));
      cursor = page.next_cursor;
      if (i === 0) {
        expect(cursor).toBeTruthy();
        expect((await send({ url: `${base}?category=groceries&cursor=${cursor}` })).statusCode).toBe(422);
      }
    }
    expect(seen).toEqual(expected);
    expect(cursor).toBeNull();
    for (const query of [
      "cursor=!", "cursor=", "limit=101", "limit=1&limit=2", "limit=0", "limit=1.2", "unknown=1",
      "date_from=2026-11-02&date_to=2026-11-01",
    ]) {
      expect((await send({ url: `${base}?${query}` })).statusCode).toBe(422);
    }
  });

  it("logs method, route, status, duration and request ID without token, notes, or search terms", async () => {
    let logs = "";
    const stream = new Writable({ write(chunk, _encoding, done) { logs += String(chunk); done(); } });
    const observed = createServer(config(), stream);
    try {
      await observed.inject({ method: "POST", url: base, headers: { authorization, "idempotency-key": randomUUID() },
        payload: { amount_minor: 25, notes: "PRIVATE_NOTES" } });
      await observed.inject({ url: `${base}?merchant=PRIVATE_MERCHANT`, headers: { authorization } });
      expect(logs).not.toContain(token);
      expect(logs).not.toContain("PRIVATE_NOTES");
      expect(logs).not.toContain("PRIVATE_MERCHANT");
      expect(logs.trim().split("\n").map((line) => JSON.parse(line))).toEqual(expect.arrayContaining([
        expect.objectContaining({ method: "POST", route: "/v1/expenses", status: 201, durationMs: expect.any(Number), reqId: expect.any(String) }),
      ]));
    } finally {
      await observed.close();
    }
  });
});

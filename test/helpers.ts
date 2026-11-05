import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { inject } from "vitest";
import type { AppConfig } from "../src/config.js";
import { createPool } from "../src/db/client.js";

export const token = randomBytes(32).toString("hex");
export const authorization = `Bearer ${token}`;
export const config = (port = 8080): AppConfig => ({
  port,
  ownerTimezone: "America/Los_Angeles",
  apiInternalBaseUrl: `http://127.0.0.1:${port}`,
  apiBearerToken: token,
  db: inject("db"),
});

export const quiet = new Writable({ write(_chunk, _encoding, done) { done(); } });

export async function resetExpenses() {
  const pool = createPool(inject("db"));
  try {
    await pool.query("TRUNCATE expense_create_requests, expenses");
  } finally {
    await pool.end();
  }
}

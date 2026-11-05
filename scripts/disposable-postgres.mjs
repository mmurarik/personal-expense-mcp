import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";

export async function freePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

export async function startDisposablePostgres() {
  const port = await freePort();
  const directory = await mkdtemp(join(tmpdir(), "expense-pg-"));
  const db = {
    host: "127.0.0.1",
    port,
    user: "expenses_app",
    password: randomBytes(32).toString("hex"),
    database: "expenses",
  };
  const postgres = new EmbeddedPostgres({
    databaseDir: join(directory, "data"),
    port,
    user: db.user,
    password: db.password,
    persistent: false,
    authMethod: "scram-sha-256",
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    postgresFlags: ["-h", db.host, "-k", directory],
    onLog: () => {},
  });
  let started = false;
  const stop = async () => {
    if (started) await postgres.stop();
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await postgres.initialise();
    await postgres.start();
    started = true;
    await postgres.createDatabase(db.database);
    return { db, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

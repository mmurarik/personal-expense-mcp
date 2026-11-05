import type { TestProject } from "vitest/node";
import { startDisposablePostgres } from "../scripts/disposable-postgres.mjs";
import type { DbConfig } from "../src/config.js";
import { createDb, createPool } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";

declare module "vitest" {
  export interface ProvidedContext {
    db: DbConfig;
  }
}

export default async function setup(project: TestProject) {
  const cluster = await startDisposablePostgres();
  try {
    const pool = createPool(cluster.db);
    try {
      await runMigrations(createDb(pool));
      await runMigrations(createDb(pool));
    } finally {
      await pool.end();
    }
  } catch (error) {
    await cluster.stop();
    throw error;
  }
  project.provide("db", cluster.db);
  return cluster.stop;
}

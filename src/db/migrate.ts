// Applies committed migrations from drizzle/. Run once per deploy as a Cloud Run Job:
//   node dist/db/migrate.js
// Drizzle records applied migrations in its own table, so rerunning is safe.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadDbConfig } from "../config.js";
import { createDb, createPool, type Database } from "./client.js";

// Resolved from the working directory: the repo root locally, /app in the container.
const MIGRATIONS_FOLDER = path.resolve(process.cwd(), "drizzle");

export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

async function main(): Promise<void> {
  const pool = createPool(loadDbConfig());
  try {
    await runMigrations(createDb(pool));
    console.log("Migrations applied.");
  } finally {
    await pool.end();
  }
}

// Run only when executed directly, not when tests import runMigrations.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("Migration failed. Check database settings, connectivity, and migration privileges.");
    process.exitCode = 1;
  });
}

import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { DbConfig } from "../config.js";
import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;

/**
 * A small, bounded pool of database connections.
 * Cloud Run runs at most 2 instances, so the database sees at most 6 connections.
 */
export function createPool(config: DbConfig): pg.Pool {
  const pool = new pg.Pool({
    // On Cloud Run, host is the Cloud SQL socket directory (/cloudsql/PROJECT:REGION:INSTANCE).
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: 3,
    connectionTimeoutMillis: 5_000, // give up waiting for a connection after 5s
    idleTimeoutMillis: 30_000, // close connections nobody has used for 30s
    query_timeout: 10_000, // the client stops waiting for a query after 10s
    statement_timeout: 10_000, // the database cancels a query that runs over 10s
  });
  // An idle connection can drop, for example while the database restarts.
  // Log it instead of letting the unhandled error crash the process.
  pool.on("error", () => {
    console.error(JSON.stringify({ level: "error", msg: "idle database connection error" }));
  });
  return pool;
}

export function createDb(pool: pg.Pool): Database {
  return drizzle(pool, { schema });
}

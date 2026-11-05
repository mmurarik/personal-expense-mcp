import type { DbConfig } from "../src/config.js";
export function freePort(): Promise<number>;
export function startDisposablePostgres(): Promise<{ db: DbConfig; stop: () => Promise<void> }>;

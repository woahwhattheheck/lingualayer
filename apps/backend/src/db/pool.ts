/**
 * Lazily-constructed Postgres pool shared by the API routes and the indexer.
 *
 * The pool is only created when `DATABASE_URL` is configured, so the scaffold
 * API can still boot without a database (dataset routes then report 503).
 */
import { Pool } from "pg";
import { config } from "../config/env.js";

let pool: Pool | null = null;

/** Return the shared pool, creating it on first use. `null` if no DATABASE_URL. */
export function getPool(): Pool | null {
  if (pool) return pool;
  if (!config.indexer.databaseUrl) return null;
  pool = new Pool({ connectionString: config.indexer.databaseUrl });
  return pool;
}

/** Close the pool (used on graceful shutdown). */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

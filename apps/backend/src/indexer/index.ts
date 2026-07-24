/**
 * Standalone indexer worker entrypoint.
 *
 * Run with `npm run indexer:start`. Wires the live Soroban RPC source and the
 * Postgres pool into the poll loop and runs until the process is signalled.
 */
import { config } from "../config/env.js";
import { getPool, closePool } from "../db/pool.js";
import { startIndexer } from "./poller.js";
import { createRpcEventSource } from "./rpc.js";

async function main(): Promise<void> {
  const pool = getPool();
  if (!pool) {
    throw new Error(
      "DATABASE_URL is required to run the indexer (set it in apps/backend/.env)",
    );
  }

  const source = createRpcEventSource(config.indexer.sorobanRpcUrl);
  let running = true;

  const shutdown = async () => {
    running = false;
    await closePool();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(
    `[indexer] polling ${config.indexer.contractId} via ${config.indexer.sorobanRpcUrl} ` +
      `every ${config.indexer.pollIntervalMs}ms (page size ${config.indexer.pageSize})`,
  );

  await startIndexer(
    { source, db: pool },
    {
      contractId: config.indexer.contractId,
      startLedger: config.indexer.startLedger,
      pageSize: config.indexer.pageSize,
    },
    {
      intervalMs: config.indexer.pollIntervalMs,
      shouldContinue: () => running,
      onCycle: (r) =>
        console.log(
          `[indexer] ledgers ${r.fromLedger}..${r.toLedger} — ` +
            `fetched ${r.fetched}, upserted ${r.upserted}, skipped ${r.skipped}`,
        ),
      onError: (e) => console.error("[indexer] cycle failed:", e),
    },
  );
}

main().catch((err) => {
  console.error("[indexer] fatal:", err);
  process.exit(1);
});

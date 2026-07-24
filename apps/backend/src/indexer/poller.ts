/**
 * Poll orchestration for the DatasetRegistry indexer.
 *
 * `runIndexerCycle` performs one fetch → decode → persist → advance-cursor pass
 * and is pure with respect to its injected `source` and `db`, so it is fully
 * unit-testable. `startIndexer` wraps it in a resumable loop with backoff.
 */
import { decodeDatasetRegistered } from "./decode.js";
import {
  initSchema,
  loadCursor,
  saveCursor,
  upsertDataset,
  type Queryable,
} from "./store.js";
import type { RawSorobanEvent } from "./types.js";

export interface EventPage {
  events: RawSorobanEvent[];
  /** Network tip ledger at query time. */
  latestLedger: number;
}

/** Source of contract events (satisfied by the Soroban RPC wrapper). */
export interface EventSource {
  getEvents(query: {
    startLedger: number;
    contractIds: string[];
    limit: number;
  }): Promise<EventPage>;
}

export interface IndexerConfig {
  contractId: string;
  /** Ledger to start from when no cursor exists yet. */
  startLedger: number;
  /** Max events to request per poll. */
  pageSize: number;
}

export interface CycleResult {
  fromLedger: number;
  toLedger: number;
  fetched: number;
  upserted: number;
  skipped: number;
}

/**
 * Run a single poll cycle. Reads the cursor (falling back to `startLedger`),
 * fetches a page of events, decodes and upserts the DatasetRegistry ones, then
 * advances and persists the cursor.
 */
export async function runIndexerCycle(
  deps: { source: EventSource; db: Queryable },
  config: IndexerConfig,
): Promise<CycleResult> {
  const { source, db } = deps;

  const cursor = await loadCursor(db);
  const fromLedger = cursor ? cursor.lastLedger + 1 : config.startLedger;

  const { events, latestLedger } = await source.getEvents({
    startLedger: fromLedger,
    contractIds: [config.contractId],
    limit: config.pageSize,
  });

  let upserted = 0;
  let skipped = 0;
  let lastEventId = cursor?.lastEventId ?? null;
  let maxEventLedger = 0;

  for (const event of events) {
    const record = decodeDatasetRegistered(event);
    if (!record) {
      skipped += 1;
      continue;
    }
    await upsertDataset(db, record);
    upserted += 1;
    lastEventId = event.id;
    if (event.ledger > maxEventLedger) maxEventLedger = event.ledger;
  }

  const toLedger = nextCursorLedger({
    fromLedger,
    latestLedger,
    fetched: events.length,
    maxEventLedger,
    pageFull: events.length >= config.pageSize,
  });

  await saveCursor(db, { lastLedger: toLedger, lastEventId });

  return { fromLedger, toLedger, fetched: events.length, upserted, skipped };
}

/**
 * Decide the ledger the cursor advances to. When a page is full there may be
 * more events inside the last-seen ledger, so we stop just before it and
 * re-scan it next cycle (upserts are idempotent). Otherwise we jump to the
 * network tip, skipping empty ranges.
 */
function nextCursorLedger(args: {
  fromLedger: number;
  latestLedger: number;
  fetched: number;
  maxEventLedger: number;
  pageFull: boolean;
}): number {
  const floor = args.fromLedger - 1; // never move the cursor backwards
  if (args.fetched === 0) {
    return Math.max(floor, args.latestLedger);
  }
  if (args.pageFull) {
    return Math.max(floor, args.maxEventLedger - 1);
  }
  return Math.max(floor, args.maxEventLedger, args.latestLedger);
}

export interface LoopControls {
  /** Poll interval in ms. */
  intervalMs: number;
  /** Returns false to stop the loop (defaults to run forever). */
  shouldContinue?: () => boolean;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Called after each cycle (or error) for logging/metrics. */
  onCycle?: (result: CycleResult) => void;
  onError?: (error: unknown) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Continuously run poll cycles. Ensures the schema exists, then loops with a
 * fixed interval, applying exponential backoff (capped) after failures so a
 * flaky RPC endpoint can't hot-loop.
 */
export async function startIndexer(
  deps: { source: EventSource; db: Queryable },
  config: IndexerConfig,
  controls: LoopControls,
): Promise<void> {
  const sleep = controls.sleep ?? defaultSleep;
  const shouldContinue = controls.shouldContinue ?? (() => true);
  const maxBackoff = Math.max(controls.intervalMs, 30_000);

  await initSchema(deps.db);

  let backoff = controls.intervalMs;
  while (shouldContinue()) {
    try {
      const result = await runIndexerCycle(deps, config);
      controls.onCycle?.(result);
      backoff = controls.intervalMs; // reset after a clean cycle
      await sleep(controls.intervalMs);
    } catch (error) {
      controls.onError?.(error);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, maxBackoff);
    }
  }
}

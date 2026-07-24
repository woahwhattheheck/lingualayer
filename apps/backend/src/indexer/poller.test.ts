import { describe, it, expect } from "vitest";
import {
  runIndexerCycle,
  startIndexer,
  type EventPage,
  type EventSource,
} from "./poller.js";
import type { Queryable } from "./store.js";
import { buildRegisteredEvent } from "./__fixtures.js";
import type { RawSorobanEvent } from "./types.js";

/**
 * Minimal in-memory Postgres stand-in: enough SQL pattern-matching to exercise
 * the real store queries (upsert, cursor load/save) without a live database.
 */
class FakeDb implements Queryable {
  datasets = new Map<string, Record<string, unknown>>();
  cursor: { last_ledger: number; last_event_id: string | null } | null = null;

  async query(text: string, params: readonly unknown[] = []) {
    const sql = text.trim();
    if (sql.startsWith("CREATE")) return { rows: [], rowCount: 0 };

    if (sql.startsWith("INSERT INTO datasets")) {
      const id = params[0] as string;
      this.datasets.set(id, {
        dataset_id: id,
        owner: params[1],
        language_code: params[2],
        ledger: params[10],
        event_id: params[11],
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith("INSERT INTO indexer_cursor")) {
      this.cursor = {
        last_ledger: params[1] as number,
        last_event_id: (params[2] as string | null) ?? null,
      };
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith("SELECT last_ledger")) {
      return {
        rows: this.cursor
          ? [{ ...this.cursor, updated_at: new Date("2026-01-01T00:00:00Z") }]
          : [],
      };
    }

    throw new Error(`FakeDb: unhandled query: ${sql.slice(0, 40)}`);
  }
}

/** A source that returns a fixed page. */
function source(events: RawSorobanEvent[], latestLedger: number): EventSource {
  return {
    async getEvents(): Promise<EventPage> {
      return { events, latestLedger };
    },
  };
}

const config = { contractId: "C-TEST", startLedger: 10, pageSize: 100 };

describe("runIndexerCycle", () => {
  it("indexes matching events and advances the cursor to the tip", async () => {
    const db = new FakeDb();
    const events = [
      buildRegisteredEvent({ datasetId: "ds_1", id: "e1", ledger: 12 }),
      buildRegisteredEvent({ datasetId: "ds_2", id: "e2", ledger: 15 }),
    ];

    const result = await runIndexerCycle({ source: source(events, 20), db }, config);

    expect(result.fromLedger).toBe(10);
    expect(result.fetched).toBe(2);
    expect(result.upserted).toBe(2);
    expect(result.skipped).toBe(0);
    // Not a full page → caught up to the network tip.
    expect(result.toLedger).toBe(20);
    expect(db.datasets.size).toBe(2);
    expect(db.cursor).toEqual({ last_ledger: 20, last_event_id: "e2" });
  });

  it("skips non-DatasetRegistry events", async () => {
    const db = new FakeDb();
    const good = buildRegisteredEvent({ datasetId: "ds_1", id: "e1", ledger: 12 });
    const noise = buildRegisteredEvent({ id: "e2", ledger: 13 });
    noise.topic = good.topic.slice(0, 1); // wrong topic shape

    const result = await runIndexerCycle(
      { source: source([good, noise], 20), db },
      config,
    );

    expect(result.upserted).toBe(1);
    expect(result.skipped).toBe(1);
    expect(db.datasets.size).toBe(1);
  });

  it("is idempotent across replays (upsert, not duplicate)", async () => {
    const db = new FakeDb();
    const events = [buildRegisteredEvent({ datasetId: "ds_1", id: "e1", ledger: 12 })];

    await runIndexerCycle({ source: source(events, 20), db }, config);
    await runIndexerCycle({ source: source(events, 20), db }, config);

    expect(db.datasets.size).toBe(1);
  });

  it("advances past empty ranges when no events are returned", async () => {
    const db = new FakeDb();
    const result = await runIndexerCycle({ source: source([], 99), db }, config);
    expect(result.fetched).toBe(0);
    expect(result.toLedger).toBe(99);
    expect(db.cursor).toEqual({ last_ledger: 99, last_event_id: null });
  });

  it("resumes from the persisted cursor on the next run", async () => {
    const db = new FakeDb();
    db.cursor = { last_ledger: 50, last_event_id: "prev" };

    const result = await runIndexerCycle({ source: source([], 60), db }, config);
    expect(result.fromLedger).toBe(51);
  });

  it("holds the cursor just before the last ledger when a page is full", async () => {
    const db = new FakeDb();
    const smallPage = { ...config, pageSize: 2 };
    const events = [
      buildRegisteredEvent({ datasetId: "ds_1", id: "e1", ledger: 12 }),
      buildRegisteredEvent({ datasetId: "ds_2", id: "e2", ledger: 18 }),
    ];

    const result = await runIndexerCycle(
      { source: source(events, 20), db },
      smallPage,
    );
    // Full page → re-scan the last-seen ledger next cycle.
    expect(result.toLedger).toBe(17);
  });
});

describe("startIndexer", () => {
  it("runs cycles until shouldContinue returns false", async () => {
    const db = new FakeDb();
    let cycles = 0;
    const events = [buildRegisteredEvent({ datasetId: "ds_1", id: "e1", ledger: 12 })];

    await startIndexer({ source: source(events, 20), db }, config, {
      intervalMs: 1,
      sleep: async () => {},
      shouldContinue: () => cycles < 3,
      onCycle: () => {
        cycles += 1;
      },
    });

    expect(cycles).toBe(3);
  });

  it("backs off and keeps looping after a cycle error", async () => {
    const db = new FakeDb();
    let calls = 0;
    const flaky: EventSource = {
      async getEvents() {
        calls += 1;
        if (calls === 1) throw new Error("rpc down");
        return { events: [], latestLedger: 5 };
      },
    };
    const sleeps: number[] = [];

    await startIndexer({ source: flaky, db }, config, {
      intervalMs: 10,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      shouldContinue: () => calls < 2,
    });

    expect(calls).toBe(2);
    // First sleep is the backoff after the error (>= interval).
    expect(sleeps[0]).toBeGreaterThanOrEqual(10);
  });
});

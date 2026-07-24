/**
 * Postgres persistence for the DatasetRegistry indexer.
 *
 * The store depends only on a minimal `Queryable` (satisfied by both `pg.Pool`
 * and `pg.PoolClient`), so unit tests can inject an in-memory fake without a
 * live database. All writes are idempotent: re-processing the same event — which
 * happens whenever the indexer restarts mid-page or an RPC page overlaps the
 * cursor — must never create duplicate rows or corrupt the cursor.
 */
import type { DatasetRegisteredRecord, IndexerCursor } from "./types.js";

/** The subset of `pg.Pool` this module needs. */
export interface Queryable {
  query(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: unknown[]; rowCount?: number | null }>;
}

/** Single logical row the indexer resumes from. */
const CURSOR_ID = "dataset-registry";

/**
 * Create the indexer's tables if they don't exist. Safe to call on every boot.
 */
export async function initSchema(db: Queryable): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS datasets (
      dataset_id       TEXT PRIMARY KEY,
      owner            TEXT NOT NULL,
      language_code    TEXT NOT NULL,
      name             TEXT NOT NULL,
      metadata_hash    TEXT NOT NULL,
      version          INTEGER NOT NULL,
      sample_count     INTEGER NOT NULL,
      duration_seconds INTEGER NOT NULL,
      commission_id    TEXT,
      created_ledger   INTEGER NOT NULL,
      ledger           INTEGER NOT NULL,
      event_id         TEXT NOT NULL,
      tx_hash          TEXT,
      indexed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS datasets_language_code_idx ON datasets (language_code)`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS datasets_owner_idx ON datasets (owner)`,
  );
  await db.query(`
    CREATE TABLE IF NOT EXISTS indexer_cursor (
      id            TEXT PRIMARY KEY,
      last_ledger   INTEGER NOT NULL,
      last_event_id TEXT,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

/**
 * Idempotently upsert a decoded dataset. Conflicts on `dataset_id` update in
 * place, so replaying an event is a no-op beyond refreshing the row.
 */
export async function upsertDataset(
  db: Queryable,
  record: DatasetRegisteredRecord,
): Promise<void> {
  await db.query(
    `
    INSERT INTO datasets (
      dataset_id, owner, language_code, name, metadata_hash, version,
      sample_count, duration_seconds, commission_id, created_ledger,
      ledger, event_id, tx_hash
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (dataset_id) DO UPDATE SET
      owner            = EXCLUDED.owner,
      language_code    = EXCLUDED.language_code,
      name             = EXCLUDED.name,
      metadata_hash    = EXCLUDED.metadata_hash,
      version          = EXCLUDED.version,
      sample_count     = EXCLUDED.sample_count,
      duration_seconds = EXCLUDED.duration_seconds,
      commission_id    = EXCLUDED.commission_id,
      created_ledger   = EXCLUDED.created_ledger,
      ledger           = EXCLUDED.ledger,
      event_id         = EXCLUDED.event_id,
      tx_hash          = EXCLUDED.tx_hash
    `,
    [
      record.datasetId,
      record.owner,
      record.languageCode,
      record.name,
      record.metadataHash,
      record.version,
      record.sampleCount,
      record.durationSeconds,
      record.commissionId,
      record.createdLedger,
      record.ledger,
      record.eventId,
      record.txHash,
    ],
  );
}

/** Load the persisted cursor, or `null` if the indexer has never run. */
export async function loadCursor(db: Queryable): Promise<IndexerCursor | null> {
  const result = await db.query(
    `SELECT last_ledger, last_event_id, updated_at FROM indexer_cursor WHERE id = $1`,
    [CURSOR_ID],
  );
  const row = result.rows[0] as
    | { last_ledger: number; last_event_id: string | null; updated_at: Date | string }
    | undefined;
  if (!row) return null;
  return {
    lastLedger: Number(row.last_ledger),
    lastEventId: row.last_event_id,
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : String(row.updated_at),
  };
}

/** Persist the cursor after a successful poll cycle. */
export async function saveCursor(
  db: Queryable,
  cursor: Pick<IndexerCursor, "lastLedger" | "lastEventId">,
): Promise<void> {
  await db.query(
    `
    INSERT INTO indexer_cursor (id, last_ledger, last_event_id, updated_at)
    VALUES ($1, $2, $3, now())
    ON CONFLICT (id) DO UPDATE SET
      last_ledger   = EXCLUDED.last_ledger,
      last_event_id = EXCLUDED.last_event_id,
      updated_at    = now()
    `,
    [CURSOR_ID, cursor.lastLedger, cursor.lastEventId],
  );
}

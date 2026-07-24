-- DatasetRegistry indexer schema (issue #82).
--
-- The indexer also creates these tables at boot via `initSchema` (see
-- src/indexer/store.ts); this file is the canonical, reviewable DDL and can be
-- applied with `psql "$DATABASE_URL" -f migrations/001_datasets.sql`.

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
);

CREATE INDEX IF NOT EXISTS datasets_language_code_idx ON datasets (language_code);
CREATE INDEX IF NOT EXISTS datasets_owner_idx ON datasets (owner);

-- Single-row resume cursor for the poll loop.
CREATE TABLE IF NOT EXISTS indexer_cursor (
  id            TEXT PRIMARY KEY,
  last_ledger   INTEGER NOT NULL,
  last_event_id TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

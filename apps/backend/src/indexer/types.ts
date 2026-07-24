/**
 * Domain types for the DatasetRegistry event indexer.
 *
 * The indexer's job is to turn raw Soroban contract events emitted by the
 * `DatasetRegistry` contract into rows in Postgres. These types describe the
 * wire shape we read from Soroban RPC (`RawSorobanEvent`), the decoded domain
 * event (`DatasetRegisteredRecord`), and the persisted cursor that lets the
 * indexer resume where it left off.
 */

/** Topic pair the DatasetRegistry contract publishes for a new dataset. */
export const DATASET_REGISTERED_TOPIC = ["dataset", "registered"] as const;

/**
 * A single event as returned by Soroban RPC `getEvents`, normalized so both
 * topics and value are base64-encoded XDR `ScVal`s. This is deliberately the
 * raw wire format (not SDK objects) so decoding is a pure, dependency-light,
 * fully unit-testable function.
 */
export interface RawSorobanEvent {
  /** Globally unique, monotonic event id (also used as the paging cursor). */
  id: string;
  /** Ledger sequence the event was emitted in. */
  ledger: number;
  /** ISO-8601 close time of that ledger, when available. */
  ledgerClosedAt?: string;
  /** Contract that emitted the event (strkey `C...`). */
  contractId: string;
  /** Transaction hash that produced the event, when available. */
  txHash?: string;
  /** Base64 XDR `ScVal` for each topic. */
  topic: string[];
  /** Base64 XDR `ScVal` for the event payload. */
  value: string;
}

/**
 * A decoded `("dataset", "registered")` event, flattened to the fields the
 * indexer persists. `null` decode results are events that don't match the
 * DatasetRegistry schema and are skipped.
 */
export interface DatasetRegisteredRecord {
  datasetId: string;
  owner: string;
  languageCode: string;
  name: string;
  /** Lowercase hex of the 32-byte metadata hash. */
  metadataHash: string;
  version: number;
  sampleCount: number;
  durationSeconds: number;
  /** `null` when the dataset was registered without a commission. */
  commissionId: string | null;
  /** Ledger recorded inside the event payload. */
  createdLedger: number;
  /** Ledger the event was emitted in (from event metadata). */
  ledger: number;
  /** Unique event id / paging token. */
  eventId: string;
  txHash: string | null;
}

/** Where the indexer resumes from on the next poll. */
export interface IndexerCursor {
  /** Last fully-processed ledger sequence. */
  lastLedger: number;
  /** Paging token of the last processed event, if any. */
  lastEventId: string | null;
  updatedAt: string;
}

/**
 * Pure decoding of raw Soroban events into typed domain records.
 *
 * No network or database access lives here, so every branch is unit-testable by
 * constructing `ScVal`s directly. The only dependency is the Stellar SDK's XDR
 * codec (`xdr` + `scValToNative`).
 */
import { xdr, scValToNative } from "@stellar/stellar-sdk";
import {
  DATASET_REGISTERED_TOPIC,
  type DatasetRegisteredRecord,
  type RawSorobanEvent,
} from "./types.js";

/** Decode a base64 XDR `ScVal` into its native JS representation. */
function nativeFromXdr(base64: string): unknown {
  return scValToNative(xdr.ScVal.fromXDR(base64, "base64"));
}

/** Coerce SDK-native values (which may be `bigint`) into a finite number. */
function toNumber(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  throw new TypeError(`expected numeric value, got ${typeof value}`);
}

function toHex(value: unknown): string {
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (typeof value === "string") return value;
  throw new TypeError(`expected bytes for hash, got ${typeof value}`);
}

/** True when the event's topics are exactly `("dataset", "registered")`. */
export function isDatasetRegistered(event: RawSorobanEvent): boolean {
  if (event.topic.length < DATASET_REGISTERED_TOPIC.length) return false;
  let topics: unknown[];
  try {
    topics = event.topic.map(nativeFromXdr);
  } catch {
    return false;
  }
  return DATASET_REGISTERED_TOPIC.every((expected, i) => topics[i] === expected);
}

/**
 * Decode a raw event into a `DatasetRegisteredRecord`, or `null` if it is not a
 * well-formed DatasetRegistry `registered` event. Malformed payloads never
 * throw — they are skipped — so one bad event can't stall the indexer.
 */
export function decodeDatasetRegistered(
  event: RawSorobanEvent,
): DatasetRegisteredRecord | null {
  if (!isDatasetRegistered(event)) return null;

  let payload: Record<string, unknown>;
  try {
    const decoded = nativeFromXdr(event.value);
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
      return null;
    }
    payload = decoded as Record<string, unknown>;
  } catch {
    return null;
  }

  try {
    const commissionRaw = payload.commission_id;
    return {
      datasetId: String(payload.id),
      owner: String(payload.owner),
      languageCode: String(payload.language_code),
      name: String(payload.name),
      metadataHash: toHex(payload.metadata_hash),
      version: toNumber(payload.version),
      sampleCount: toNumber(payload.sample_count),
      durationSeconds: toNumber(payload.duration_seconds),
      commissionId:
        commissionRaw === null || commissionRaw === undefined
          ? null
          : String(commissionRaw),
      createdLedger: toNumber(payload.created_ledger),
      ledger: event.ledger,
      eventId: event.id,
      txHash: event.txHash ?? null,
    };
  } catch {
    // A structurally-valid event with an unexpected field shape is skipped
    // rather than crashing the poll loop.
    return null;
  }
}

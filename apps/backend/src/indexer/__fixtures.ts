/**
 * Test-only helpers that build real base64 XDR `ScVal`s mirroring what the
 * DatasetRegistry contract emits, so decode/poll tests exercise the genuine
 * Stellar SDK codec rather than mocks. Excluded from the production build.
 */
import { xdr, Address, Keypair } from "@stellar/stellar-sdk";
import type { RawSorobanEvent } from "./types.js";

const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const u32 = (n: number) => xdr.ScVal.scvU32(n);
const str = (s: string) => xdr.ScVal.scvString(s);
const entry = (k: string, v: xdr.ScVal) =>
  new xdr.ScMapEntry({ key: sym(k), val: v });

export interface EventFixtureOverrides {
  id?: string;
  ledger?: number;
  contractId?: string;
  txHash?: string;
  datasetId?: string;
  owner?: string;
  languageCode?: string;
  name?: string;
  metadataByte?: number;
  version?: number;
  sampleCount?: number;
  durationSeconds?: number;
  commissionId?: string | null;
  createdLedger?: number;
  /** Emit sample_count as a u64 to exercise the bigint→number path. */
  sampleCountAsU64?: boolean;
}

/** A random valid `G...` account strkey. */
export function randomAddress(): string {
  return Keypair.random().publicKey();
}

/** Stable default owner strkey so tests can assert the decoded value. */
export const DEFAULT_OWNER = randomAddress();

/** Build a topic array `("dataset", "registered")` (or custom) as base64 XDR. */
export function buildTopics(topics: string[] = ["dataset", "registered"]): string[] {
  return topics.map((t) => sym(t).toXDR("base64"));
}

/** Build a full `dataset registered` raw event with sensible defaults. */
export function buildRegisteredEvent(
  overrides: EventFixtureOverrides = {},
): RawSorobanEvent {
  const owner = overrides.owner ?? DEFAULT_OWNER;
  const commission = overrides.commissionId ?? null;
  const sampleCount = overrides.sampleCount ?? 1234;

  const value = xdr.ScVal.scvMap([
    entry(
      "commission_id",
      commission === null ? xdr.ScVal.scvVoid() : str(commission),
    ),
    entry("created_ledger", u32(overrides.createdLedger ?? 42)),
    entry("duration_seconds", u32(overrides.durationSeconds ?? 600)),
    entry("id", str(overrides.datasetId ?? "ds_1")),
    entry("language_code", str(overrides.languageCode ?? "yo")),
    entry(
      "metadata_hash",
      xdr.ScVal.scvBytes(Buffer.alloc(32, overrides.metadataByte ?? 7)),
    ),
    entry("name", str(overrides.name ?? "Yoruba Proverbs")),
    entry("owner", new Address(owner).toScVal()),
    entry(
      "sample_count",
      overrides.sampleCountAsU64
        ? xdr.ScVal.scvU64(new xdr.Uint64(BigInt(sampleCount)))
        : u32(sampleCount),
    ),
    entry("version", u32(overrides.version ?? 1)),
  ]);

  return {
    id: overrides.id ?? "0000000000000001-0000000001",
    ledger: overrides.ledger ?? 100,
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    contractId:
      overrides.contractId ?? "CBET4YWSMIZB3LGLVTDKQJ5HXQAPQGM3NKGXJLJEJQNF7TBDOVMXUOK",
    txHash: overrides.txHash ?? "abc123",
    topic: buildTopics(),
    value: value.toXDR("base64"),
  };
}

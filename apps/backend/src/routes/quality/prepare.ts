import { StrKey } from "@stellar/stellar-sdk";

export interface AttestQualityInput {
  curator: string;
  datasetId: string;
  score: number;
  rubricHash: string;
}

export type AttestQualityValidation =
  | { ok: true; value: AttestQualityInput }
  | { ok: false; error: string };

const RUBRIC_HASH_PATTERN = /^[0-9a-fA-F]{64}$/;

/**
 * Validates the request body for POST /quality/attest/prepare. Kept separate
 * from the route handler so it's testable without a Soroban RPC round-trip —
 * the handler only needs to touch the network once these checks pass.
 */
export function validateAttestQualityInput(body: unknown): AttestQualityValidation {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const { curator, datasetId, score, rubricHash } = body as Record<string, unknown>;

  if (typeof curator !== "string" || !StrKey.isValidEd25519PublicKey(curator)) {
    return { ok: false, error: "'curator' must be a valid Stellar public key (G...)" };
  }
  if (typeof datasetId !== "string" || datasetId.trim().length === 0) {
    return { ok: false, error: "'datasetId' is required" };
  }
  if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 100) {
    return { ok: false, error: "'score' must be an integer between 0 and 100" };
  }
  if (typeof rubricHash !== "string" || !RUBRIC_HASH_PATTERN.test(rubricHash)) {
    return { ok: false, error: "'rubricHash' must be 64 hex characters (32 bytes)" };
  }

  return { ok: true, value: { curator, datasetId, score, rubricHash } };
}

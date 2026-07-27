import { StrKey } from "@stellar/stellar-sdk";

export interface PostCommissionInput {
  commissioner: string;
  languageCode: string;
  descriptionHash: string;
  bountyToken: string;
  bountyAmount: string;
  minSampleCount: number;
  minDurationSeconds: number;
  deadlineLedger: number;
}

export type PostCommissionValidation =
  | { ok: true; value: PostCommissionInput }
  | { ok: false; error: string };

const HASH_PATTERN = /^[0-9a-fA-F]{64}$/;
const INTEGER_PATTERN = /^(0|[1-9][0-9]*)$/;

function validAddress(value: unknown): value is string {
  return typeof value === "string" && StrKey.isValidEd25519PublicKey(value);
}

function validContractAddress(value: unknown): value is string {
  return typeof value === "string" && StrKey.isValidContract(value);
}

function validU32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 4_294_967_295;
}

/** Validate the JSON body for POST /commissions/prepare without contacting RPC. */
export function validatePostCommissionInput(body: unknown): PostCommissionValidation {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Request body must be a JSON object" };
  }

  const input = body as Record<string, unknown>;
  if (!validAddress(input.commissioner)) {
    return { ok: false, error: "'commissioner' must be a valid Stellar public key (G...)" };
  }
  if (typeof input.languageCode !== "string" || input.languageCode.trim().length === 0) {
    return { ok: false, error: "'languageCode' is required" };
  }
  if (input.languageCode.length > 32) {
    return { ok: false, error: "'languageCode' must be at most 32 characters" };
  }
  if (typeof input.descriptionHash !== "string" || !HASH_PATTERN.test(input.descriptionHash)) {
    return { ok: false, error: "'descriptionHash' must be 64 hex characters (32 bytes)" };
  }
  if (!validContractAddress(input.bountyToken)) {
    return { ok: false, error: "'bountyToken' must be a valid Stellar contract address (C...)" };
  }
  if (typeof input.bountyAmount !== "string" || !INTEGER_PATTERN.test(input.bountyAmount) || input.bountyAmount === "0") {
    return { ok: false, error: "'bountyAmount' must be a positive integer string" };
  }
  if (!validU32(input.minSampleCount)) {
    return { ok: false, error: "'minSampleCount' must be an unsigned 32-bit integer" };
  }
  if (!validU32(input.minDurationSeconds)) {
    return { ok: false, error: "'minDurationSeconds' must be an unsigned 32-bit integer" };
  }
  if (!validU32(input.deadlineLedger) || input.deadlineLedger === 0) {
    return { ok: false, error: "'deadlineLedger' must be a positive unsigned 32-bit integer" };
  }

  return {
    ok: true,
    value: {
      commissioner: input.commissioner,
      languageCode: input.languageCode,
      descriptionHash: input.descriptionHash,
      bountyToken: input.bountyToken,
      bountyAmount: input.bountyAmount,
      minSampleCount: input.minSampleCount,
      minDurationSeconds: input.minDurationSeconds,
      deadlineLedger: input.deadlineLedger,
    },
  };
}

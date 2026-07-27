import { describe, expect, it } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { validatePostCommissionInput } from "./prepare.js";

const COMMISSIONER = Keypair.random().publicKey();
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 1));
const HASH = "ab".repeat(32);

const validBody = () => ({
  commissioner: COMMISSIONER,
  languageCode: "yo",
  descriptionHash: HASH,
  bountyToken: TOKEN,
  bountyAmount: "1000000000",
  minSampleCount: 100,
  minDurationSeconds: 3600,
  deadlineLedger: 5000,
});

describe("validatePostCommissionInput", () => {
  it("accepts a well-formed request", () => {
    expect(validatePostCommissionInput(validBody())).toEqual({ ok: true, value: validBody() });
  });

  it("rejects non-objects and invalid addresses", () => {
    expect(validatePostCommissionInput(null)).toEqual({ ok: false, error: "Request body must be a JSON object" });
    expect(validatePostCommissionInput({ ...validBody(), commissioner: "not-an-address" })).toMatchObject({ ok: false });
    expect(validatePostCommissionInput({ ...validBody(), bountyToken: COMMISSIONER })).toEqual({
      ok: false,
      error: "'bountyToken' must be a valid Stellar contract address (C...)",
    });
  });

  it("rejects malformed hashes and non-positive bounty amounts", () => {
    expect(validatePostCommissionInput({ ...validBody(), descriptionHash: "short" })).toMatchObject({ ok: false });
    expect(validatePostCommissionInput({ ...validBody(), bountyAmount: "0" })).toEqual({
      ok: false,
      error: "'bountyAmount' must be a positive integer string",
    });
    expect(validatePostCommissionInput({ ...validBody(), bountyAmount: "1.5" })).toMatchObject({ ok: false });
  });

  it("rejects invalid ledger and numeric bounds", () => {
    expect(validatePostCommissionInput({ ...validBody(), deadlineLedger: 0 })).toMatchObject({ ok: false });
    expect(validatePostCommissionInput({ ...validBody(), minSampleCount: 1.2 })).toMatchObject({ ok: false });
    expect(validatePostCommissionInput({ ...validBody(), minDurationSeconds: 4_294_967_296 })).toMatchObject({ ok: false });
  });
});

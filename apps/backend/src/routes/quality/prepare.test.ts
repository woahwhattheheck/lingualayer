import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { validateAttestQualityInput } from "./prepare.js";

const CURATOR = Keypair.random().publicKey();
const RUBRIC_HASH = "ab".repeat(32);

describe("validateAttestQualityInput", () => {
  it("accepts a well-formed request", () => {
    const result = validateAttestQualityInput({
      curator: CURATOR,
      datasetId: "yoruba-speech-v2",
      score: 75,
      rubricHash: RUBRIC_HASH,
    });
    expect(result).toEqual({
      ok: true,
      value: { curator: CURATOR, datasetId: "yoruba-speech-v2", score: 75, rubricHash: RUBRIC_HASH },
    });
  });

  it("rejects a non-object body", () => {
    expect(validateAttestQualityInput(null)).toEqual({
      ok: false,
      error: "Request body must be a JSON object",
    });
    expect(validateAttestQualityInput("nope")).toMatchObject({ ok: false });
  });

  it("rejects an invalid curator address", () => {
    const result = validateAttestQualityInput({
      curator: "not-a-stellar-address",
      datasetId: "ds",
      score: 50,
      rubricHash: RUBRIC_HASH,
    });
    expect(result).toEqual({
      ok: false,
      error: "'curator' must be a valid Stellar public key (G...)",
    });
  });

  it("rejects a missing/blank datasetId", () => {
    expect(
      validateAttestQualityInput({ curator: CURATOR, datasetId: "  ", score: 50, rubricHash: RUBRIC_HASH }),
    ).toEqual({ ok: false, error: "'datasetId' is required" });
  });

  it.each([-1, 101, 50.5, "50"])("rejects an out-of-range or non-integer score %p", (score) => {
    const result = validateAttestQualityInput({
      curator: CURATOR,
      datasetId: "ds",
      score,
      rubricHash: RUBRIC_HASH,
    });
    expect(result).toEqual({ ok: false, error: "'score' must be an integer between 0 and 100" });
  });

  it.each(["too-short", "zz".repeat(32), RUBRIC_HASH.slice(0, 63)])(
    "rejects a malformed rubricHash %p",
    (rubricHash) => {
      const result = validateAttestQualityInput({ curator: CURATOR, datasetId: "ds", score: 50, rubricHash });
      expect(result).toEqual({ ok: false, error: "'rubricHash' must be 64 hex characters (32 bytes)" });
    },
  );
});

import { describe, it, expect } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import { decodeDatasetRegistered, isDatasetRegistered } from "./decode.js";
import {
  buildRegisteredEvent,
  buildTopics,
  DEFAULT_OWNER,
} from "./__fixtures.js";

describe("decodeDatasetRegistered", () => {
  it("decodes a well-formed registered event", () => {
    const event = buildRegisteredEvent({
      datasetId: "ds_7",
      languageCode: "sw",
      name: "Swahili Corpus",
      version: 1,
      sampleCount: 1234,
      durationSeconds: 600,
      createdLedger: 42,
      metadataByte: 0xab,
      ledger: 555,
      id: "evt-1",
      txHash: "deadbeef",
    });

    const record = decodeDatasetRegistered(event);
    expect(record).not.toBeNull();
    expect(record).toMatchObject({
      datasetId: "ds_7",
      owner: DEFAULT_OWNER,
      languageCode: "sw",
      name: "Swahili Corpus",
      metadataHash: "ab".repeat(32),
      version: 1,
      sampleCount: 1234,
      durationSeconds: 600,
      commissionId: null,
      createdLedger: 42,
      ledger: 555,
      eventId: "evt-1",
      txHash: "deadbeef",
    });
  });

  it("carries a present commission id", () => {
    const record = decodeDatasetRegistered(
      buildRegisteredEvent({ commissionId: "cm_9" }),
    );
    expect(record?.commissionId).toBe("cm_9");
  });

  it("coerces bigint numeric fields to number", () => {
    const record = decodeDatasetRegistered(
      buildRegisteredEvent({ sampleCount: 9000, sampleCountAsU64: true }),
    );
    expect(record?.sampleCount).toBe(9000);
    expect(typeof record?.sampleCount).toBe("number");
  });

  it("returns null for a non-matching topic", () => {
    const event = buildRegisteredEvent();
    event.topic = buildTopics(["dataset", "deprecated"]);
    expect(isDatasetRegistered(event)).toBe(false);
    expect(decodeDatasetRegistered(event)).toBeNull();
  });

  it("returns null when there are too few topics", () => {
    const event = buildRegisteredEvent();
    event.topic = buildTopics(["dataset"]);
    expect(decodeDatasetRegistered(event)).toBeNull();
  });

  it("returns null (never throws) for a malformed value payload", () => {
    const event = buildRegisteredEvent();
    // A scalar value where a map is expected must be skipped, not crash.
    event.value = xdr.ScVal.scvU32(1).toXDR("base64");
    expect(() => decodeDatasetRegistered(event)).not.toThrow();
    expect(decodeDatasetRegistered(event)).toBeNull();
  });

  it("returns null for undecodable base64 without throwing", () => {
    const event = buildRegisteredEvent();
    event.value = "not-valid-xdr";
    expect(() => decodeDatasetRegistered(event)).not.toThrow();
    expect(decodeDatasetRegistered(event)).toBeNull();
  });
});

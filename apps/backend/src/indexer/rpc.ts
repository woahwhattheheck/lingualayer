/**
 * Soroban RPC adapter: turns the Stellar SDK's `getEvents` response into the
 * normalized `RawSorobanEvent` shape the poller consumes. Keeping this thin and
 * behind the `EventSource` interface means the poll logic never depends on SDK
 * internals and stays unit-testable with a fake source.
 */
import { rpc } from "@stellar/stellar-sdk";
import type { EventPage, EventSource } from "./poller.js";
import type { RawSorobanEvent } from "./types.js";

/** Convert a value that may be an SDK `ScVal` or already-base64 into base64. */
function toBase64Xdr(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof (value as { toXDR?: unknown }).toXDR === "function") {
    return (value as { toXDR(format: "base64"): string }).toXDR("base64");
  }
  throw new TypeError("event field is neither base64 XDR nor an ScVal");
}

function normalize(event: {
  id: string;
  ledger: number;
  ledgerClosedAt?: string;
  contractId?: { toString(): string } | string;
  txHash?: string;
  topic: unknown[];
  value: unknown;
}): RawSorobanEvent {
  return {
    id: event.id,
    ledger: Number(event.ledger),
    ledgerClosedAt: event.ledgerClosedAt,
    contractId:
      typeof event.contractId === "string"
        ? event.contractId
        : (event.contractId?.toString() ?? ""),
    txHash: event.txHash,
    topic: event.topic.map(toBase64Xdr),
    value: toBase64Xdr(event.value),
  };
}

/**
 * Build an `EventSource` backed by a live Soroban RPC endpoint. Only contract
 * events for the given contract ids are requested.
 */
export function createRpcEventSource(rpcUrl: string): EventSource {
  const server = new rpc.Server(rpcUrl, {
    allowHttp: rpcUrl.startsWith("http://"),
  });

  return {
    async getEvents(query): Promise<EventPage> {
      const response = await server.getEvents({
        startLedger: query.startLedger,
        filters: [
          {
            type: "contract",
            contractIds: query.contractIds,
            topics: [],
          },
        ],
        limit: query.limit,
      });

      return {
        latestLedger: Number(response.latestLedger),
        events: (response.events ?? []).map((e) =>
          normalize(e as Parameters<typeof normalize>[0]),
        ),
      };
    },
  };
}

import type { FastifyPluginAsync } from "fastify";
import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { config } from "../../config/env.js";
import { validateAttestQualityInput } from "./prepare.js";

const networkPassphrase =
  config.stellarNetwork === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

const rpcServer = new rpc.Server(config.sorobanRpcUrl);

function loadQualityOracle(): Contract {
  if (!config.qualityOracleContractId) {
    throw new Error("QUALITY_ORACLE_CONTRACT_ID is not configured");
  }
  return new Contract(config.qualityOracleContractId);
}

type Tier = "Unrated" | "Bronze" | "Silver" | "Gold" | "Platinum";

interface CuratorLeaderboardEntry {
  address: string;
  attestationCount: number;
  averageScore: number;
  tier: Tier;
}

// Mirrors QualityOracle::compute_tier in contracts/quality-oracle/src/lib.rs.
function tierForScore(score: number): Tier {
  if (score === 0) return "Unrated";
  if (score <= 39) return "Bronze";
  if (score <= 69) return "Silver";
  if (score <= 84) return "Gold";
  return "Platinum";
}

// QualityOracle's read-only view functions require no auth, so this only ever
// needs to simulate a transaction (never submit it) — a fresh, unfunded
// keypair as the tx source is sufficient.
async function callReadOnly<T>(method: string, ...params: xdr.ScVal[]): Promise<T> {
  const qualityOracle = loadQualityOracle();
  const source = new Account(Keypair.random().publicKey(), "0");
  const tx = new TransactionBuilder(source, {
    fee: "100",
    networkPassphrase,
  })
    .addOperation(qualityOracle.call(method, ...params))
    .setTimeout(30)
    .build();

  const sim = await rpcServer.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`QualityOracle.${method} simulation failed: ${sim.error}`);
  }
  if (!sim.result) {
    throw new Error(`QualityOracle.${method} simulation returned no result`);
  }
  return scValToNative(sim.result.retval) as T;
}

let cache: { entries: CuratorLeaderboardEntry[]; expiresAt: number } | null = null;

async function loadLeaderboard(): Promise<CuratorLeaderboardEntry[]> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.entries;

  const curators = await callReadOnly<string[]>("list_curators");

  const entries = await Promise.all(
    curators.map(async (address): Promise<CuratorLeaderboardEntry> => {
      const stats = await callReadOnly<Record<string, unknown>>(
        "get_curator_stats",
        nativeToScVal(address, { type: "address" }),
      );
      const averageScore = Number(stats.average_score ?? 0);
      return {
        address,
        attestationCount: Number(stats.attestation_count ?? 0),
        averageScore,
        tier: tierForScore(averageScore),
      };
    }),
  );

  entries.sort(
    (a, b) => b.attestationCount - a.attestationCount || b.averageScore - a.averageScore,
  );

  cache = { entries, expiresAt: now + config.leaderboardCacheTtlMs };
  return entries;
}

export const qualityRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { limit?: string } }>(
    "/quality/leaderboard",
    async (request, reply) => {
      const requested = Number(request.query.limit ?? 20);
      const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 100) : 20;

      try {
        const entries = await loadLeaderboard();
        return {
          curators: entries.slice(0, limit).map((entry, index) => ({
            rank: index + 1,
            ...entry,
          })),
          generatedAt: new Date().toISOString(),
        };
      } catch (err) {
        app.log.error(err);
        return reply.code(502).send({
          error: "Failed to load curator leaderboard from the QualityOracle contract",
        });
      }
    },
  );

  /**
   * Prepares (builds + simulates) an `attest_quality` invocation and returns
   * its assembled, unsigned XDR. The curator's wallet signs the returned
   * transaction client-side and submits it — this endpoint never holds a
   * curator secret key. `curator` is both the contract argument and the
   * transaction source account, since `attest_quality` calls
   * `curator.require_auth()`.
   */
  app.post<{ Body: unknown }>("/quality/attest/prepare", async (request, reply) => {
    const validation = validateAttestQualityInput(request.body);
    if (!validation.ok) {
      return reply.code(400).send({ error: validation.error });
    }
    const { curator, datasetId, score, rubricHash } = validation.value;

    let qualityOracle: Contract;
    try {
      qualityOracle = loadQualityOracle();
    } catch (err) {
      app.log.error(err);
      return reply.code(500).send({ error: "QUALITY_ORACLE_CONTRACT_ID is not configured" });
    }

    let account: Account;
    try {
      account = await rpcServer.getAccount(curator);
    } catch (err) {
      app.log.warn(err);
      return reply.code(400).send({
        error: `Couldn't load curator account ${curator} from the network — is it funded on ${config.stellarNetwork}?`,
      });
    }

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(
        qualityOracle.call(
          "attest_quality",
          nativeToScVal(curator, { type: "address" }),
          nativeToScVal(datasetId, { type: "string" }),
          nativeToScVal(score, { type: "u32" }),
          nativeToScVal(Buffer.from(rubricHash, "hex"), { type: "bytes" }),
        ),
      )
      .setTimeout(30)
      .build();

    let prepared;
    try {
      prepared = await rpcServer.prepareTransaction(tx);
    } catch (err) {
      app.log.warn(err);
      return reply.code(502).send({
        error:
          "Simulating attest_quality failed — the curator may not be registered, may be slashed, or the contract rejected this call.",
      });
    }

    return {
      transaction: prepared.toXDR(),
      network_passphrase: networkPassphrase,
    };
  });
};

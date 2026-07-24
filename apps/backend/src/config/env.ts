import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(8080),
  API_PREFIX: z.string().default("/api/v1"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),

  // --- Indexer configuration ---
  // Postgres connection string. Optional so the API can boot without a DB in
  // dev/scaffold mode; the indexer worker requires it.
  DATABASE_URL: z.string().optional(),
  // Soroban RPC endpoint used to fetch contract events.
  SOROBAN_RPC_URL: z
    .string()
    .url()
    .default("https://soroban-testnet.stellar.org"),
  // Deployed DatasetRegistry contract id (defaults to the testnet address).
  DATASET_REGISTRY_CONTRACT_ID: z
    .string()
    .default("CBET4YWSMIZB3LGLVTDKQJ5HXQAPQGM3NKGXJLJEJQNF7TBDOVMXUOK"),
  // Ledger the indexer starts from when no cursor is persisted yet.
  INDEXER_START_LEDGER: z.coerce.number().int().positive().default(1),
  // Delay between poll cycles, in milliseconds.
  INDEXER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  // Max events requested per poll.
  INDEXER_PAGE_SIZE: z.coerce.number().int().positive().max(10_000).default(100),

  STELLAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),

  SEP10_SERVER_SECRET: z.string().optional(),
  SEP10_HOME_DOMAIN: z.string().default("lingualayer.vercel.app"),
  SEP10_WEB_AUTH_DOMAIN: z.string().optional(),
  SEP10_CHALLENGE_TIMEOUT_SECONDS: z.coerce.number().default(300),

  JWT_SECRET: z.string().optional(),
  JWT_TTL_SECONDS: z.coerce.number().default(3600),

  // QualityOracle curator leaderboard
  SOROBAN_RPC_URL: z.string().default("https://soroban-testnet.stellar.org"),
  QUALITY_ORACLE_CONTRACT_ID: z.string().optional(),
  LEADERBOARD_CACHE_TTL_MS: z.coerce.number().default(30_000),
});

const raw = schema.parse(process.env);

export const config = {
  nodeEnv: raw.NODE_ENV,
  port: raw.PORT,
  apiPrefix: raw.API_PREFIX,
  corsOrigin: raw.CORS_ORIGIN,
  indexer: {
    databaseUrl: raw.DATABASE_URL,
    sorobanRpcUrl: raw.SOROBAN_RPC_URL,
    contractId: raw.DATASET_REGISTRY_CONTRACT_ID,
    startLedger: raw.INDEXER_START_LEDGER,
    pollIntervalMs: raw.INDEXER_POLL_INTERVAL_MS,
    pageSize: raw.INDEXER_PAGE_SIZE,
  },

  stellarNetwork: raw.STELLAR_NETWORK,

  sep10ServerSecret: raw.SEP10_SERVER_SECRET,
  sep10HomeDomain: raw.SEP10_HOME_DOMAIN,
  sep10WebAuthDomain: raw.SEP10_WEB_AUTH_DOMAIN ?? raw.SEP10_HOME_DOMAIN,
  sep10ChallengeTimeoutSeconds: raw.SEP10_CHALLENGE_TIMEOUT_SECONDS,

  jwtSecret: raw.JWT_SECRET,
  jwtTtlSeconds: raw.JWT_TTL_SECONDS,

  sorobanRpcUrl: raw.SOROBAN_RPC_URL,
  qualityOracleContractId: raw.QUALITY_ORACLE_CONTRACT_ID,
  leaderboardCacheTtlMs: raw.LEADERBOARD_CACHE_TTL_MS,
};

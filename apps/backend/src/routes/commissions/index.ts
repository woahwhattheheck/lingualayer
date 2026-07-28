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
} from "@stellar/stellar-sdk";
import { config } from "../../config/env.js";
import { insufficientBalanceError, validatePostCommissionInput } from "./prepare.js";

const networkPassphrase = config.stellarNetwork === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
const rpcServer = new rpc.Server(config.sorobanRpcUrl);

function loadDataCommission(): Contract {
  if (!config.dataCommissionContractId) {
    throw new Error("DATA_COMMISSION_CONTRACT_ID is not configured");
  }
  return new Contract(config.dataCommissionContractId);
}

/**
 * Reads a SAC token's balance for `holder` via simulation only (no auth,
 * no submission) — a fresh, unfunded keypair as the tx source is enough
 * since `balance` is a read-only view function.
 */
async function getTokenBalance(tokenContractId: string, holder: string): Promise<bigint> {
  const token = new Contract(tokenContractId);
  const source = new Account(Keypair.random().publicKey(), "0");
  const tx = new TransactionBuilder(source, { fee: "100", networkPassphrase })
    .addOperation(token.call("balance", nativeToScVal(holder, { type: "address" })))
    .setTimeout(30)
    .build();

  const sim = await rpcServer.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`balance simulation failed for token ${tokenContractId}: ${sim.error}`);
  }
  if (!sim.result) {
    throw new Error(`balance simulation for token ${tokenContractId} returned no result`);
  }
  return scValToNative(sim.result.retval) as bigint;
}

export const commissionRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Build and simulate an unsigned post_commission call. The commissioner is
   * the transaction source because the contract requires commissioner auth;
   * the caller signs and submits the returned XDR in their own wallet.
   */
  app.post<{ Body: unknown }>("/commissions/prepare", async (request, reply) => {
    const validation = validatePostCommissionInput(request.body);
    if (!validation.ok) return reply.code(400).send({ error: validation.error });
    const input = validation.value;

    let dataCommission: Contract;
    try {
      dataCommission = loadDataCommission();
    } catch (err) {
      app.log.error(err);
      return reply.code(500).send({ error: "DATA_COMMISSION_CONTRACT_ID is not configured" });
    }

    let account: Account;
    try {
      account = await rpcServer.getAccount(input.commissioner);
    } catch (err) {
      app.log.warn(err);
      return reply.code(400).send({
        error: `Couldn't load commissioner account ${input.commissioner} from the network — is it funded on ${config.stellarNetwork}?`,
      });
    }

    const requiredAmount = BigInt(input.bountyAmount);
    let balance: bigint;
    try {
      balance = await getTokenBalance(input.bountyToken, input.commissioner);
    } catch (err) {
      app.log.warn(err);
      return reply.code(502).send({
        error: "Couldn't verify the commissioner's bounty token balance — check the bountyToken contract address.",
      });
    }
    if (balance < requiredAmount) {
      return reply.code(400).send({ error: insufficientBalanceError(balance, requiredAmount) });
    }

    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
      .addOperation(
        dataCommission.call(
          "post_commission",
          nativeToScVal(input.commissioner, { type: "address" }),
          nativeToScVal(input.languageCode, { type: "string" }),
          nativeToScVal(Buffer.from(input.descriptionHash, "hex"), { type: "bytes" }),
          nativeToScVal(input.bountyToken, { type: "address" }),
          nativeToScVal(BigInt(input.bountyAmount), { type: "i128" }),
          nativeToScVal(input.minSampleCount, { type: "u32" }),
          nativeToScVal(input.minDurationSeconds, { type: "u32" }),
          nativeToScVal(input.deadlineLedger, { type: "u32" }),
        ),
      )
      .setTimeout(30)
      .build();

    try {
      const prepared = await rpcServer.prepareTransaction(tx);
      return { transaction: prepared.toXDR(), network_passphrase: networkPassphrase };
    } catch (err) {
      app.log.warn(err);
      return reply.code(502).send({
        error: "Simulating post_commission failed — check the bounty token, balance, and commission parameters.",
      });
    }
  });
};

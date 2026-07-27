import type { FastifyPluginAsync } from "fastify";
import {
  Account,
  BASE_FEE,
  Contract,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from "@stellar/stellar-sdk";
import { config } from "../../config/env.js";
import { validatePostCommissionInput } from "./prepare.js";

const networkPassphrase = config.stellarNetwork === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
const rpcServer = new rpc.Server(config.sorobanRpcUrl);

function loadDataCommission(): Contract {
  if (!config.dataCommissionContractId) {
    throw new Error("DATA_COMMISSION_CONTRACT_ID is not configured");
  }
  return new Contract(config.dataCommissionContractId);
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

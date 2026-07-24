import type { FastifyPluginAsync } from "fastify";
import { datasetRoutes } from "./datasets.js";
import { sep10Routes } from "../sep10/index.js";
import { qualityRoutes } from "../quality/index.js";

export const v1Routes: FastifyPluginAsync = async (app) => {
  app.get("/meta", async () => ({
    name: "lingualayer-api",
    version: "0.1.0",
    description: "REST facade for Soroban contracts and indexers (scaffold).",
  }));

  // Read API over indexed DatasetRegistry events.
  await app.register(datasetRoutes);
  await app.register(sep10Routes);
  await app.register(qualityRoutes);

  // TODO: routes for contract invocation prep, webhook ingestion, admin ops
};

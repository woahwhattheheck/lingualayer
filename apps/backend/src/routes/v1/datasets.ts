/**
 * Read API over the indexed DatasetRegistry data.
 *
 *   GET /datasets            — list indexed datasets (filter by language/owner)
 *   GET /datasets/:id        — fetch a single indexed dataset
 *   GET /indexer/status      — cursor + row counts for the indexer
 *
 * All routes degrade gracefully to 503 when no database is configured, so the
 * scaffold API still boots without Postgres.
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getPool } from "../../db/pool.js";
import { loadCursor } from "../../indexer/store.js";

const listQuery = z.object({
  language: z.string().min(1).optional(),
  owner: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const datasetRoutes: FastifyPluginAsync = async (app) => {
  app.get("/datasets", async (request, reply) => {
    const pool = getPool();
    if (!pool) return reply.code(503).send({ error: "database not configured" });

    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid query", details: parsed.error.flatten() });
    }
    const { language, owner, limit, offset } = parsed.data;

    // Build a parameterized WHERE so filters are injection-safe.
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (language) {
      params.push(language);
      conditions.push(`language_code = $${params.length}`);
    }
    if (owner) {
      params.push(owner);
      conditions.push(`owner = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    params.push(limit, offset);
    const result = await pool.query(
      `SELECT dataset_id, owner, language_code, name, metadata_hash, version,
              sample_count, duration_seconds, commission_id, created_ledger,
              ledger, event_id, tx_hash, indexed_at
         FROM datasets ${where}
         ORDER BY created_ledger DESC, dataset_id DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return { count: result.rowCount ?? result.rows.length, datasets: result.rows };
  });

  app.get<{ Params: { id: string } }>("/datasets/:id", async (request, reply) => {
    const pool = getPool();
    if (!pool) return reply.code(503).send({ error: "database not configured" });

    const result = await pool.query(
      `SELECT dataset_id, owner, language_code, name, metadata_hash, version,
              sample_count, duration_seconds, commission_id, created_ledger,
              ledger, event_id, tx_hash, indexed_at
         FROM datasets WHERE dataset_id = $1`,
      [request.params.id],
    );
    if (result.rows.length === 0) {
      return reply.code(404).send({ error: "dataset not found" });
    }
    return result.rows[0];
  });

  app.get("/indexer/status", async (_request, reply) => {
    const pool = getPool();
    if (!pool) return reply.code(503).send({ error: "database not configured" });

    const [cursor, counts] = await Promise.all([
      loadCursor(pool),
      pool.query(`SELECT count(*)::int AS total FROM datasets`),
    ]);
    return {
      cursor,
      datasetsIndexed: (counts.rows[0] as { total: number }).total,
    };
  });
};

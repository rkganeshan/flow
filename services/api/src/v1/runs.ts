import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "../db.js";
import { getTenantIdFromHeaders, toHttpError } from "../http.js";

const CreateManualRunBody = z
  .object({
    input: z.unknown().optional(),
    // Reserved for future: idempotency key for client-side dedupe
    idempotency_key: z.string().min(1).optional(),
  })
  .default({});

const UpdateRunStatusBody = z
  .object({
    // reserved for future: optimistic concurrency / actor metadata
    reason: z.string().min(1).optional(),
  })
  .default({});

export async function registerRunsRoutes(app: FastifyInstance) {
  const db: Db = (app as any).db;
  const runRequestsQueue = (app as any).queues?.runRequests;

  // List runs (most recent first)
  app.get("/", async (req, reply) => {
    try {
      const tenantId = getTenantIdFromHeaders(req.headers);
      const r = await db.pool.query(
        `select id, tenant_id, workflow_version_id, trigger_event_id, status,
                started_at, finished_at, created_at, updated_at
           from workflow_runs
          where tenant_id = $1
          order by created_at desc
          limit 100`,
        [tenantId],
      );
      return { items: r.rows };
    } catch (e) {
      const { statusCode, body } = toHttpError(e, app.log);
      return reply.code(statusCode).send(body);
    }
  });

  // Get a single run
  app.get("/:runId", async (req, reply) => {
    try {
      const tenantId = getTenantIdFromHeaders(req.headers);
      const runId = (req.params as any).runId as string;

      const r = await db.pool.query(
        `select id, tenant_id, workflow_version_id, trigger_event_id, status,
                input, error, started_at, finished_at, created_at, updated_at
           from workflow_runs
          where tenant_id = $1 and id = $2`,
        [tenantId, runId],
      );
      if (r.rowCount === 0) return reply.code(404).send({ error: "not_found" });
      return r.rows[0];
    } catch (e) {
      const { statusCode, body } = toHttpError(e, app.log);
      return reply.code(statusCode).send(body);
    }
  });

  // List node runs for a run (timeline)
  app.get("/:runId/node-runs", async (req, reply) => {
    try {
      const tenantId = getTenantIdFromHeaders(req.headers);
      const runId = (req.params as any).runId as string;

      const r = await db.pool.query(
        `select nr.id, nr.tenant_id, nr.workflow_run_id, nr.node_id, nr.node_type,
                nr.status, nr.attempt, nr.max_attempts,
                nr.queued_at, nr.started_at, nr.finished_at,
                nr.outcome, nr.error, nr.created_at, nr.updated_at
           from node_runs nr
          where nr.tenant_id = $1 and nr.workflow_run_id = $2
          order by nr.created_at asc`,
        [tenantId, runId],
      );
      return { items: r.rows };
    } catch (e) {
      const { statusCode, body } = toHttpError(e, app.log);
      return reply.code(statusCode).send(body);
    }
  });

  // List logs for a node run
  app.get("/node-runs/:nodeRunId/logs", async (req, reply) => {
    try {
      const tenantId = getTenantIdFromHeaders(req.headers);
      const nodeRunId = (req.params as any).nodeRunId as string;

      const r = await db.pool.query(
        `select id, tenant_id, node_run_id, ts, level, message, data
           from node_run_logs
          where tenant_id = $1 and node_run_id = $2
          order by ts asc
          limit 500`,
        [tenantId, nodeRunId],
      );
      return { items: r.rows };
    } catch (e) {
      const { statusCode, body } = toHttpError(e, app.log);
      return reply.code(statusCode).send(body);
    }
  });

  // ----
  // Run control (MVP): start/pause/resume/cancel
  // These are safe/idempotent DB state transitions; the engine will later enforce execution semantics.
  // ----

  app.post(
    "/:runId/start",
    { config: { requiredRole: "editor" } },
    async (req, reply) => {
      try {
        const tenantId = getTenantIdFromHeaders(req.headers);
        const runId = (req.params as any).runId as string;

        const parsed = UpdateRunStatusBody.safeParse(req.body ?? {});
        if (!parsed.success) {
          return reply
            .code(400)
            .send({ error: "invalid_body", details: parsed.error.flatten() });
        }

        const r = await db.pool.query(
          `update workflow_runs
            set status = 'RUNNING'::workflow_run_status,
                started_at = coalesce(started_at, now()),
                updated_at = now()
          where tenant_id = $1 and id = $2
            and status in ('PENDING', 'PAUSED')
          returning id, tenant_id, workflow_version_id, trigger_event_id, status,
                    started_at, finished_at, created_at, updated_at`,
          [tenantId, runId],
        );

        if (r.rowCount === 0) {
          // If it exists but is already RUNNING/terminal, treat it as idempotent.
          const cur = await db.pool.query(
            `select id, tenant_id, workflow_version_id, trigger_event_id, status,
                  started_at, finished_at, created_at, updated_at
             from workflow_runs
            where tenant_id = $1 and id = $2`,
            [tenantId, runId],
          );
          if (cur.rowCount === 0)
            return reply.code(404).send({ error: "not_found" });

          // If already RUNNING, still ensure a run_requests job exists (safe due to deterministic jobId).
          if (cur.rows[0].status === "RUNNING") {
            if (runRequestsQueue) {
              try {
                await runRequestsQueue.add(
                  "run_request",
                  { run_id: runId },
                  {
                    jobId: `run_request-${runId}`,
                    removeOnComplete: 1000,
                    removeOnFail: 1000,
                  },
                );
              } catch (err) {
                app.log.error(
                  { err },
                  "failed to enqueue run_request for existing RUNNING run",
                );
                throw Object.assign(new Error("queue_enqueue_failed"), {
                  statusCode: 500,
                });
              }
            }
          }

          return reply.code(200).send(cur.rows[0]);
        }

        if (runRequestsQueue) {
          try {
            await runRequestsQueue.add(
              "run_request",
              { run_id: runId },
              {
                jobId: `run_request-${runId}`,
                removeOnComplete: 1000,
                removeOnFail: 1000,
              },
            );
          } catch (err) {
            app.log.error({ err }, "failed to enqueue run_request after start");
            throw Object.assign(new Error("queue_enqueue_failed"), {
              statusCode: 500,
            });
          }
        }

        return reply.code(200).send(r.rows[0]);
      } catch (e) {
        const { statusCode, body } = toHttpError(e, app.log);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.post(
    "/:runId/pause",
    { config: { requiredRole: "editor" } },
    async (req, reply) => {
      try {
        const tenantId = getTenantIdFromHeaders(req.headers);
        const runId = (req.params as any).runId as string;

        const parsed = UpdateRunStatusBody.safeParse(req.body ?? {});
        if (!parsed.success) {
          return reply
            .code(400)
            .send({ error: "invalid_body", details: parsed.error.flatten() });
        }

        const r = await db.pool.query(
          `update workflow_runs
            set status = 'PAUSED'::workflow_run_status,
                updated_at = now()
          where tenant_id = $1 and id = $2
            and status = 'RUNNING'
          returning id, tenant_id, workflow_version_id, trigger_event_id, status,
                    started_at, finished_at, created_at, updated_at`,
          [tenantId, runId],
        );

        if (r.rowCount === 0) {
          const cur = await db.pool.query(
            `select id, tenant_id, workflow_version_id, trigger_event_id, status,
                  started_at, finished_at, created_at, updated_at
             from workflow_runs
            where tenant_id = $1 and id = $2`,
            [tenantId, runId],
          );
          if (cur.rowCount === 0)
            return reply.code(404).send({ error: "not_found" });
          return reply.code(200).send(cur.rows[0]);
        }

        return reply.code(200).send(r.rows[0]);
      } catch (e) {
        const { statusCode, body } = toHttpError(e, app.log);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.post(
    "/:runId/resume",
    { config: { requiredRole: "editor" } },
    async (req, reply) => {
      try {
        const tenantId = getTenantIdFromHeaders(req.headers);
        const runId = (req.params as any).runId as string;

        const parsed = UpdateRunStatusBody.safeParse(req.body ?? {});
        if (!parsed.success) {
          return reply
            .code(400)
            .send({ error: "invalid_body", details: parsed.error.flatten() });
        }

        const r = await db.pool.query(
          `update workflow_runs
            set status = 'RUNNING'::workflow_run_status,
                updated_at = now()
          where tenant_id = $1 and id = $2
            and status = 'PAUSED'
          returning id, tenant_id, workflow_version_id, trigger_event_id, status,
                    started_at, finished_at, created_at, updated_at`,
          [tenantId, runId],
        );

        if (r.rowCount === 0) {
          const cur = await db.pool.query(
            `select id, tenant_id, workflow_version_id, trigger_event_id, status,
                  started_at, finished_at, created_at, updated_at
             from workflow_runs
            where tenant_id = $1 and id = $2`,
            [tenantId, runId],
          );
          if (cur.rowCount === 0)
            return reply.code(404).send({ error: "not_found" });
          return reply.code(200).send(cur.rows[0]);
        }

        if (runRequestsQueue) {
          try {
            await runRequestsQueue.add(
              "run_request",
              { run_id: runId },
              {
                jobId: `run_request-${runId}`,
                removeOnComplete: 1000,
                removeOnFail: 1000,
              },
            );
          } catch (err) {
            app.log.error({ err }, "failed to enqueue run_request on resume");
            throw Object.assign(new Error("queue_enqueue_failed"), {
              statusCode: 500,
            });
          }
        }

        return reply.code(200).send(r.rows[0]);
      } catch (e) {
        const { statusCode, body } = toHttpError(e, app.log);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.post(
    "/:runId/cancel",
    { config: { requiredRole: "editor" } },
    async (req, reply) => {
      try {
        const tenantId = getTenantIdFromHeaders(req.headers);
        const runId = (req.params as any).runId as string;

        const parsed = UpdateRunStatusBody.safeParse(req.body ?? {});
        if (!parsed.success) {
          return reply
            .code(400)
            .send({ error: "invalid_body", details: parsed.error.flatten() });
        }

        const r = await db.pool.query(
          `update workflow_runs
            set status = 'CANCELLED'::workflow_run_status,
                finished_at = coalesce(finished_at, now()),
                updated_at = now()
          where tenant_id = $1 and id = $2
            and status in ('PENDING', 'RUNNING', 'PAUSED')
          returning id, tenant_id, workflow_version_id, trigger_event_id, status,
                    started_at, finished_at, created_at, updated_at`,
          [tenantId, runId],
        );

        if (r.rowCount === 0) {
          const cur = await db.pool.query(
            `select id, tenant_id, workflow_version_id, trigger_event_id, status,
                  started_at, finished_at, created_at, updated_at
             from workflow_runs
            where tenant_id = $1 and id = $2`,
            [tenantId, runId],
          );
          if (cur.rowCount === 0)
            return reply.code(404).send({ error: "not_found" });
          return reply.code(200).send(cur.rows[0]);
        }

        return reply.code(200).send(r.rows[0]);
      } catch (e) {
        const { statusCode, body } = toHttpError(e, app.log);
        return reply.code(statusCode).send(body);
      }
    },
  );

  // NOTE: manual run create is registered under /v1/workflows for a clean resource hierarchy.
}

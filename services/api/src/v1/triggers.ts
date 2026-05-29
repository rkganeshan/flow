import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "../db.js";
import { toHttpError } from "../http.js";

const WebhookBody = z.unknown().optional();

/**
 * Webhook trigger ingestion.
 *
 * Design goals:
 * - No auth header required (this is for 3rd-party systems)
 * - Protect with a per-workflow secret (stored in workflow draft_graph for MVP)
 * - Strong dedupe via trigger_events unique constraint
 * - Create a workflow_run pinned to the latest published workflow_version
 */
export async function registerTriggersRoutes(app: FastifyInstance) {
  const db: Db = (app as any).db;

  app.post("/webhooks/:workflowId/:secret", async (req, reply) => {
    try {
      const workflowId = (req.params as any).workflowId as string;
      const secret = (req.params as any).secret as string;

      const parsedBody = WebhookBody.safeParse(req.body);
      if (!parsedBody.success) {
        return reply
          .code(400)
          .send({ error: "invalid_body", details: parsedBody.error.flatten() });
      }

      // 1) Load workflow (tenant_id + draft_graph) and validate secret.
      // MVP: store webhook secret in workflows.draft_graph.trigger.webhook_secret.
      const wf = await db.pool.query(
        `select id, tenant_id, draft_graph
           from workflows
          where id = $1`,
        [workflowId],
      );
      if (wf.rowCount === 0)
        return reply.code(404).send({ error: "not_found" });

      const tenantId = wf.rows[0].tenant_id as string;
      const draftGraph = wf.rows[0].draft_graph as any;
      const expectedSecret = draftGraph?.trigger?.webhook_secret;
      if (!expectedSecret || expectedSecret !== secret) {
        // Do not leak existence/tenant info.
        return reply.code(404).send({ error: "not_found" });
      }

      // 2) Find latest published version.
      const ver = await db.pool.query(
        `select id, version
           from workflow_versions
          where tenant_id = $1 and workflow_id = $2
          order by version desc
          limit 1`,
        [tenantId, workflowId],
      );
      if (ver.rowCount === 0) {
        return reply.code(409).send({ error: "workflow_not_published" });
      }
      const workflowVersionId = ver.rows[0].id as string;

      // 3) Idempotent trigger event insert.
      // Dedupe key strategy (MVP): caller may provide X-Flow-Dedupe-Key; else use request id.
      // This gives best-effort dedupe without external dependencies.
      const dedupeKey =
        (req.headers["x-flow-dedupe-key"] as string | undefined) ?? req.id;

      const client = await db.pool.connect();
      try {
        await client.query("begin");

        const te = await client.query(
          `insert into trigger_events (tenant_id, source, dedupe_key, payload)
           values ($1, 'webhook', $2, $3::jsonb)
           on conflict (tenant_id, source, dedupe_key)
           do update set payload = trigger_events.payload
           returning id`,
          [tenantId, dedupeKey, JSON.stringify(parsedBody.data ?? {})],
        );

        const triggerEventId = te.rows[0].id as string;

        // 4) Create workflow run (idempotent via UNIQUE constraint).
        const run = await client.query(
          `insert into workflow_runs (
             tenant_id, workflow_version_id, trigger_event_id,
             status, input, started_at, updated_at
           )
           values ($1, $2, $3, 'PENDING'::workflow_run_status, $4::jsonb, null, now())
           on conflict (tenant_id, workflow_version_id, trigger_event_id)
           do update set updated_at = now()
           returning id, tenant_id, workflow_version_id, trigger_event_id, status,
                     started_at, finished_at, created_at, updated_at`,
          [
            tenantId,
            workflowVersionId,
            triggerEventId,
            JSON.stringify(parsedBody.data ?? {}),
          ],
        );

        await client.query("commit");

        // 5) Enqueue for engine processing (BullMQ). If Redis isn't configured,
        // we still accept the trigger and rely on manual /start + /engine/tick.
        let enqueued: any = null;
        try {
          const q = (app as any).queues?.runRequests;
          if (q) {
            const job = await q.add(
              "webhook",
              {
                tenant_id: tenantId,
                run_id: run.rows[0].id,
                workflow_version_id: workflowVersionId,
              },
              {
                // Avoid duplicate queue jobs for same trigger processing.
                // BullMQ requires string jobId.
                jobId: `trigger_event-${triggerEventId}`,
                removeOnComplete: 1000,
                removeOnFail: 1000,
              },
            );
            enqueued = { queue: "run_requests", job_id: String(job.id) };
          }
        } catch {
          // best-effort queueing; DB remains truth
          enqueued = null;
        }

        // For webhook triggers, returning the run id is helpful.
        return reply.code(202).send({
          accepted: true,
          workflow_version_id: workflowVersionId,
          run: run.rows[0],
          enqueued,
        });
      } catch (e) {
        await client.query("rollback");
        throw e;
      } finally {
        client.release();
      }
    } catch (e) {
      const { statusCode, body } = toHttpError(e);
      return reply.code(statusCode).send(body);
    }
  });
}

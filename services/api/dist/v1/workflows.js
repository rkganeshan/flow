import { z } from "zod";
import { getTenantIdFromHeaders, toHttpError } from "../http.js";
const CreateWorkflowBody = z.object({
    name: z.string().min(1),
});
const UpdateWorkflowBody = z.object({
    name: z.string().min(1).optional(),
    draft_graph: z.unknown().optional(),
});
const PublishBody = z.object({
    // Optional: publish an explicit draft graph snapshot, else uses current workflows.draft_graph
    draft_graph: z.unknown().optional(),
});
const CreateManualRunBody = z
    .object({
    input: z.unknown().optional(),
    // Reserved for future: idempotency key for client-side dedupe
    idempotency_key: z.string().min(1).optional(),
})
    .default({});
export async function registerWorkflowsRoutes(app) {
    const db = app.db;
    app.get("/", async (req, reply) => {
        try {
            const tenantId = getTenantIdFromHeaders(req.headers);
            const r = await db.pool.query("select id, tenant_id, name, draft_updated_at, created_at, updated_at from workflows where tenant_id = $1 order by created_at desc limit 100", [tenantId]);
            return { items: r.rows };
        }
        catch (e) {
            const { statusCode, body } = toHttpError(e);
            return reply.code(statusCode).send(body);
        }
    });
    app.post("/", { config: { requiredRole: "editor" } }, async (req, reply) => {
        try {
            const tenantId = getTenantIdFromHeaders(req.headers);
            const parsed = CreateWorkflowBody.safeParse(req.body);
            if (!parsed.success) {
                return reply
                    .code(400)
                    .send({ error: "invalid_body", details: parsed.error.flatten() });
            }
            const { name } = parsed.data;
            const r = await db.pool.query(`insert into workflows (tenant_id, name, draft_graph)
         values ($1, $2, '{}'::jsonb)
         returning id, tenant_id, name, draft_graph, draft_updated_at, created_at, updated_at`, [tenantId, name]);
            return reply.code(201).send(r.rows[0]);
        }
        catch (e) {
            const { statusCode, body } = toHttpError(e);
            return reply.code(statusCode).send(body);
        }
    });
    app.get("/:workflowId", async (req, reply) => {
        try {
            const tenantId = getTenantIdFromHeaders(req.headers);
            const workflowId = req.params.workflowId;
            const r = await db.pool.query("select id, tenant_id, name, draft_graph, draft_updated_at, created_at, updated_at from workflows where tenant_id = $1 and id = $2", [tenantId, workflowId]);
            if (r.rowCount === 0)
                return reply.code(404).send({ error: "not_found" });
            return r.rows[0];
        }
        catch (e) {
            const { statusCode, body } = toHttpError(e);
            return reply.code(statusCode).send(body);
        }
    });
    app.get("/:workflowId/versions", async (req, reply) => {
        try {
            const tenantId = getTenantIdFromHeaders(req.headers);
            const workflowId = req.params.workflowId;
            const r = await db.pool.query(`select id, tenant_id, workflow_id, version, graph, published_at, created_at
           from workflow_versions
          where tenant_id = $1 and workflow_id = $2
          order by version desc`, [tenantId, workflowId]);
            return { items: r.rows };
        }
        catch (e) {
            const { statusCode, body } = toHttpError(e);
            return reply.code(statusCode).send(body);
        }
    });
    app.get("/:workflowId/versions/:versionId", async (req, reply) => {
        try {
            const tenantId = getTenantIdFromHeaders(req.headers);
            const workflowId = req.params.workflowId;
            const versionId = req.params.versionId;
            const r = await db.pool.query(`select id, tenant_id, workflow_id, version, graph, published_at, created_at
           from workflow_versions
          where tenant_id = $1 and workflow_id = $2 and id = $3
          limit 1`, [tenantId, workflowId, versionId]);
            if (r.rowCount === 0)
                return reply.code(404).send({ error: "not_found" });
            return r.rows[0];
        }
        catch (e) {
            const { statusCode, body } = toHttpError(e);
            return reply.code(statusCode).send(body);
        }
    });
    app.patch("/:workflowId", { config: { requiredRole: "editor" } }, async (req, reply) => {
        try {
            const tenantId = getTenantIdFromHeaders(req.headers);
            const workflowId = req.params.workflowId;
            const parsed = UpdateWorkflowBody.safeParse(req.body);
            if (!parsed.success) {
                return reply
                    .code(400)
                    .send({ error: "invalid_body", details: parsed.error.flatten() });
            }
            const { name, draft_graph } = parsed.data;
            // Build a minimal dynamic update.
            const sets = [];
            const values = [tenantId, workflowId];
            let idx = values.length;
            if (name !== undefined) {
                idx += 1;
                values.push(name);
                sets.push(`name = $${idx}`);
            }
            if (draft_graph !== undefined) {
                idx += 1;
                values.push(JSON.stringify(draft_graph));
                sets.push(`draft_graph = $${idx}::jsonb`);
                sets.push("draft_updated_at = now()");
            }
            sets.push("updated_at = now()");
            if (sets.length === 1) {
                // only updated_at got pushed
                return reply.code(400).send({ error: "no_fields_to_update" });
            }
            const r = await db.pool.query(`update workflows
         set ${sets.join(", ")}
         where tenant_id = $1 and id = $2
         returning id, tenant_id, name, draft_graph, draft_updated_at, created_at, updated_at`, values);
            if (r.rowCount === 0)
                return reply.code(404).send({ error: "not_found" });
            return r.rows[0];
        }
        catch (e) {
            const { statusCode, body } = toHttpError(e);
            return reply.code(statusCode).send(body);
        }
    });
    app.post("/:workflowId/publish", { config: { requiredRole: "editor" } }, async (req, reply) => {
        try {
            const tenantId = getTenantIdFromHeaders(req.headers);
            const workflowId = req.params.workflowId;
            const parsed = PublishBody.safeParse(req.body ?? {});
            if (!parsed.success) {
                return reply
                    .code(400)
                    .send({ error: "invalid_body", details: parsed.error.flatten() });
            }
            const client = await db.pool.connect();
            try {
                await client.query("begin");
                const wf = await client.query("select id, tenant_id, name, draft_graph from workflows where tenant_id = $1 and id = $2 for update", [tenantId, workflowId]);
                if (wf.rowCount === 0) {
                    await client.query("rollback");
                    return reply.code(404).send({ error: "not_found" });
                }
                const graph = parsed.data.draft_graph !== undefined
                    ? parsed.data.draft_graph
                    : wf.rows[0].draft_graph;
                const nextVer = await client.query("select coalesce(max(version), 0) + 1 as v from workflow_versions where workflow_id = $1", [workflowId]);
                const version = Number(nextVer.rows[0].v);
                const created = await client.query(`insert into workflow_versions (tenant_id, workflow_id, version, graph)
           values ($1, $2, $3, $4::jsonb)
           returning id, tenant_id, workflow_id, version, published_at, created_at`, [tenantId, workflowId, version, JSON.stringify(graph)]);
                await client.query("commit");
                return reply.code(201).send(created.rows[0]);
            }
            catch (e) {
                await client.query("rollback");
                throw e;
            }
            finally {
                client.release();
            }
        }
        catch (e) {
            const { statusCode, body } = toHttpError(e);
            return reply.code(statusCode).send(body);
        }
    });
    // Manual run create for a specific workflow version.
    app.post("/:workflowId/versions/:versionId/runs", { config: { requiredRole: "editor" } }, async (req, reply) => {
        try {
            const tenantId = getTenantIdFromHeaders(req.headers);
            const workflowId = req.params.workflowId;
            const versionId = req.params.versionId;
            const parsed = CreateManualRunBody.safeParse(req.body ?? {});
            if (!parsed.success) {
                return reply
                    .code(400)
                    .send({ error: "invalid_body", details: parsed.error.flatten() });
            }
            const v = await db.pool.query(`select id, workflow_id
           from workflow_versions
          where tenant_id = $1 and id = $2`, [tenantId, versionId]);
            if (v.rowCount === 0)
                return reply.code(404).send({ error: "not_found" });
            if (v.rows[0].workflow_id !== workflowId) {
                return reply.code(409).send({ error: "version_workflow_mismatch" });
            }
            const r = await db.pool.query(`insert into workflow_runs (
            tenant_id, workflow_version_id, trigger_event_id,
            status, input, started_at, updated_at
          )
          values ($1, $2, null, 'PENDING'::workflow_run_status, $3::jsonb, null, now())
          returning id, tenant_id, workflow_version_id, trigger_event_id, status,
                    started_at, finished_at, created_at, updated_at`, [tenantId, versionId, JSON.stringify(parsed.data.input ?? {})]);
            // Enqueue for engine processing (best-effort).
            let enqueued = null;
            try {
                const q = app.queues?.runRequests;
                if (q) {
                    const job = await q.add("manual", {
                        tenant_id: tenantId,
                        run_id: r.rows[0].id,
                        workflow_version_id: versionId,
                    }, {
                        // Ensure replays don't create unlimited jobs if client retries.
                        jobId: `manual_run-${r.rows[0].id}`,
                        removeOnComplete: 1000,
                        removeOnFail: 1000,
                    });
                    enqueued = { queue: "run_requests", job_id: String(job.id) };
                }
            }
            catch {
                enqueued = null;
            }
            return reply.code(201).send({ ...r.rows[0], enqueued });
        }
        catch (e) {
            const { statusCode, body } = toHttpError(e);
            return reply.code(statusCode).send(body);
        }
    });
}

import { z } from "zod";
import { getTenantIdFromHeaders, toHttpError } from "../http.js";
const TickBody = z
    .object({
    limit: z.coerce.number().int().min(1).max(100).default(10),
})
    .default({});
/**
 * Engine-only endpoints (MVP) to demonstrate durable state transitions.
 *
 * This is intentionally minimal: it creates the initial node_run for RUNNING runs
 * (if missing) based on workflow_versions.graph.
 *
 * In a real deployment, this becomes a separate engine service subscribed to queues.
 */
export async function registerEngineRoutes(app) {
    const db = app.db;
    app.post("/tick", { config: { requiredRole: "editor" } }, async (req, reply) => {
        try {
            const tenantId = getTenantIdFromHeaders(req.headers);
            const parsed = TickBody.safeParse(req.body ?? {});
            if (!parsed.success) {
                return reply
                    .code(400)
                    .send({ error: "invalid_body", details: parsed.error.flatten() });
            }
            const limit = parsed.data.limit;
            const created = [];
            const progressed = [];
            const advanced = [];
            const failedRuns = [];
            // (F) If any node has FAILED_FINAL, fail the whole workflow run.
            // This is the MVP semantics until conditional/retry policies exist.
            const failCandidates = await db.pool.query(`select wr.id as run_id
           from workflow_runs wr
          where wr.tenant_id = $1
            and wr.status = 'RUNNING'::workflow_run_status
            and exists (
              select 1
                from node_runs nr
               where nr.workflow_run_id = wr.id
                 and nr.status = 'FAILED_FINAL'::node_run_status
            )
          order by wr.updated_at asc
          limit $2`, [tenantId, limit]);
            for (const row of failCandidates.rows) {
                const runId = row.run_id;
                const client = await db.pool.connect();
                try {
                    await client.query("begin");
                    const lock = await client.query(`select id, status
               from workflow_runs
              where tenant_id = $1 and id = $2
              for update`, [tenantId, runId]);
                    if (lock.rowCount === 0 || lock.rows[0].status !== "RUNNING") {
                        await client.query("rollback");
                        continue;
                    }
                    // Pick most recent failed node_run for error payload.
                    const lastFailed = await client.query(`select id, node_id, node_type, error, finished_at
               from node_runs
              where tenant_id = $1 and workflow_run_id = $2
                and status = 'FAILED_FINAL'::node_run_status
              order by finished_at desc nulls last, updated_at desc
              limit 1`, [tenantId, runId]);
                    const errPayload = lastFailed.rowCount === 1
                        ? {
                            error: "node_failed",
                            node_run_id: lastFailed.rows[0].id,
                            node_id: lastFailed.rows[0].node_id,
                            node_type: lastFailed.rows[0].node_type,
                            node_error: lastFailed.rows[0].error,
                        }
                        : { error: "node_failed" };
                    await client.query(`update workflow_runs
                set status = 'FAILED'::workflow_run_status,
                    finished_at = now(),
                    error = $3::jsonb,
                    updated_at = now()
              where tenant_id = $1 and id = $2
                and status = 'RUNNING'::workflow_run_status`, [tenantId, runId, JSON.stringify(errPayload)]);
                    await client.query("commit");
                    failedRuns.push({ run_id: runId, error: errPayload });
                }
                catch (e) {
                    await client.query("rollback");
                    throw e;
                }
                finally {
                    client.release();
                }
            }
            // (0) Advance graph for runs that have newly SUCCEEDED nodes but no READY nodes.
            // This lets us demonstrate a claim->execute->engine-advance loop with /v1/workers.
            const advCandidates = await db.pool.query(`select wr.id as run_id, wr.workflow_version_id
           from workflow_runs wr
          where wr.tenant_id = $1
            and wr.status = 'RUNNING'::workflow_run_status
            and exists (
              select 1 from node_runs nr
               where nr.workflow_run_id = wr.id
                 and nr.status = 'SUCCEEDED'::node_run_status
            )
            and not exists (
              select 1 from node_runs nr
               where nr.workflow_run_id = wr.id
                 and nr.status in (
                   'READY'::node_run_status,
                   'IN_PROGRESS'::node_run_status,
                   'FAILED_FINAL'::node_run_status
                 )
            )
          order by wr.updated_at asc
          limit $2`, [tenantId, limit]);
            for (const row of advCandidates.rows) {
                const runId = row.run_id;
                const workflowVersionId = row.workflow_version_id;
                const client = await db.pool.connect();
                try {
                    await client.query("begin");
                    // Lock run
                    const lock = await client.query(`select id, status
               from workflow_runs
              where tenant_id = $1 and id = $2
              for update`, [tenantId, runId]);
                    if (lock.rowCount === 0) {
                        await client.query("rollback");
                        continue;
                    }
                    if (lock.rows[0].status !== "RUNNING") {
                        await client.query("rollback");
                        continue;
                    }
                    // Load graph
                    const v = await client.query(`select graph
               from workflow_versions
              where tenant_id = $1 and id = $2`, [tenantId, workflowVersionId]);
                    if (v.rowCount === 0) {
                        await client.query("rollback");
                        continue;
                    }
                    const graph = v.rows[0].graph;
                    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
                    const edges = Array.isArray(graph?.edges) ? graph.edges : [];
                    // Find the most recently finished succeeded node to advance from.
                    const last = await client.query(`select node_id
               from node_runs
              where tenant_id = $1 and workflow_run_id = $2
                and status = 'SUCCEEDED'::node_run_status
              order by finished_at desc nulls last, updated_at desc
              limit 1`, [tenantId, runId]);
                    if (last.rowCount === 0) {
                        await client.query("rollback");
                        continue;
                    }
                    const fromNodeId = last.rows[0].node_id;
                    const edge = edges.find((e) => e?.from === fromNodeId);
                    const nextNodeId = edge?.to;
                    if (nextNodeId) {
                        const nextNode = nodes.find((n) => n?.id === nextNodeId);
                        const nextType = String(nextNode?.type ?? "unknown");
                        await client.query(`insert into node_runs (
                 tenant_id, workflow_run_id, node_id, node_type,
                 status, attempt, max_attempts,
                 queued_at, input, updated_at
               )
               values ($1, $2, $3, $4, 'READY'::node_run_status, 0, 3, now(), '{}'::jsonb, now())
               on conflict (workflow_run_id, node_id)
               do update set updated_at = now()`, [tenantId, runId, String(nextNodeId), nextType]);
                        advanced.push({
                            run_id: runId,
                            from: fromNodeId,
                            to: nextNodeId,
                        });
                    }
                    else {
                        // No outgoing edge => run complete.
                        await client.query(`update workflow_runs
                  set status = 'SUCCEEDED'::workflow_run_status,
                      finished_at = now(),
                      updated_at = now()
                where tenant_id = $1 and id = $2
                  and status = 'RUNNING'::workflow_run_status`, [tenantId, runId]);
                        advanced.push({ run_id: runId, terminal: "SUCCEEDED" });
                    }
                    await client.query("commit");
                }
                catch (e) {
                    await client.query("rollback");
                    throw e;
                }
                finally {
                    client.release();
                }
            }
            // (A) Complete READY delay nodes whose timer has elapsed.
            // Graph contract for delay node: node.config.seconds: number
            const readyDelay = await db.pool.query(`select nr.id as node_run_id, nr.workflow_run_id, nr.node_id,
                wr.workflow_version_id
           from node_runs nr
           join workflow_runs wr on wr.id = nr.workflow_run_id
          where nr.tenant_id = $1
            and nr.status = 'READY'::node_run_status
            and nr.node_type = 'delay'
            and wr.status = 'RUNNING'::workflow_run_status
          order by nr.queued_at asc nulls last
          limit $2`, [tenantId, limit]);
            for (const row of readyDelay.rows) {
                const nodeRunId = row.node_run_id;
                const runId = row.workflow_run_id;
                const nodeId = row.node_id;
                const workflowVersionId = row.workflow_version_id;
                const client = await db.pool.connect();
                try {
                    await client.query("begin");
                    const nrLock = await client.query(`select id, queued_at
               from node_runs
              where tenant_id = $1 and id = $2
                and status = 'READY'::node_run_status
              for update`, [tenantId, nodeRunId]);
                    if (nrLock.rowCount === 0) {
                        await client.query("rollback");
                        continue;
                    }
                    const v = await client.query(`select graph
               from workflow_versions
              where tenant_id = $1 and id = $2`, [tenantId, workflowVersionId]);
                    if (v.rowCount === 0) {
                        await client.query("rollback");
                        continue;
                    }
                    const graph = v.rows[0].graph;
                    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
                    const edges = Array.isArray(graph?.edges) ? graph.edges : [];
                    const node = nodes.find((n) => n?.id === nodeId);
                    const secondsRaw = node?.config?.seconds;
                    const seconds = Number(secondsRaw);
                    const delayMs = Number.isFinite(seconds)
                        ? Math.max(0, seconds) * 1000
                        : 0;
                    const queuedAt = nrLock.rows[0].queued_at;
                    const dueAt = queuedAt ? queuedAt.getTime() + delayMs : Date.now();
                    if (Date.now() < dueAt) {
                        await client.query("rollback");
                        continue;
                    }
                    // Mark node run succeeded.
                    await client.query(`update node_runs
                set status = 'SUCCEEDED'::node_run_status,
                    started_at = coalesce(started_at, now()),
                    finished_at = now(),
                    outcome = 'success',
                    output = $3::jsonb,
                    updated_at = now()
              where tenant_id = $1 and id = $2`, [
                        tenantId,
                        nodeRunId,
                        JSON.stringify({ delayed_seconds: seconds }),
                    ]);
                    await client.query(`insert into node_run_logs (tenant_id, node_run_id, level, message, data)
             values ($1, $2, 'info', 'delay completed', $3::jsonb)`, [tenantId, nodeRunId, JSON.stringify({ seconds })]);
                    // Find next node via first matching edge { from, to }
                    const edge = edges.find((e) => e?.from === nodeId);
                    const nextNodeId = edge?.to;
                    if (nextNodeId) {
                        const nextNode = nodes.find((n) => n?.id === nextNodeId);
                        const nextType = String(nextNode?.type ?? "unknown");
                        // Create next node_run (idempotent due to uq_node_runs_run_node).
                        await client.query(`insert into node_runs (
                 tenant_id, workflow_run_id, node_id, node_type,
                 status, attempt, max_attempts,
                 queued_at, input, updated_at
               )
               values ($1, $2, $3, $4, 'READY'::node_run_status, 0, 3, now(), '{}'::jsonb, now())
               on conflict (workflow_run_id, node_id)
               do update set updated_at = now()`, [tenantId, runId, String(nextNodeId), nextType]);
                        progressed.push({ run_id: runId, from: nodeId, to: nextNodeId });
                    }
                    else {
                        // No outgoing edge => workflow complete.
                        await client.query(`update workflow_runs
                  set status = 'SUCCEEDED'::workflow_run_status,
                      finished_at = now(),
                      updated_at = now()
                where tenant_id = $1 and id = $2
                  and status = 'RUNNING'::workflow_run_status`, [tenantId, runId]);
                        progressed.push({ run_id: runId, terminal: "SUCCEEDED" });
                    }
                    await client.query("commit");
                }
                catch (e) {
                    await client.query("rollback");
                    throw e;
                }
                finally {
                    client.release();
                }
            }
            // (B) Create initial node_run for RUNNING runs that have no node_runs yet.
            const runs = await db.pool.query(`select wr.id as run_id, wr.workflow_version_id
           from workflow_runs wr
           left join node_runs nr on nr.workflow_run_id = wr.id
          where wr.tenant_id = $1
            and wr.status = 'RUNNING'::workflow_run_status
          group by wr.id
          having count(nr.id) = 0
          order by wr.created_at asc
          limit $2`, [tenantId, limit]);
            for (const row of runs.rows) {
                const runId = row.run_id;
                const workflowVersionId = row.workflow_version_id;
                const client = await db.pool.connect();
                try {
                    await client.query("begin");
                    // Lock run row (avoid concurrent ticks).
                    const lock = await client.query(`select id, status
               from workflow_runs
              where tenant_id = $1 and id = $2
              for update`, [tenantId, runId]);
                    if (lock.rowCount === 0) {
                        await client.query("rollback");
                        continue;
                    }
                    if (lock.rows[0].status !== "RUNNING") {
                        await client.query("rollback");
                        continue;
                    }
                    // Re-check: do we already have node_runs?
                    const existing = await client.query(`select 1 from node_runs where tenant_id = $1 and workflow_run_id = $2 limit 1`, [tenantId, runId]);
                    if (existing.rows.length > 0) {
                        await client.query("rollback");
                        continue;
                    }
                    // Load graph and compute entry node.
                    const v = await client.query(`select graph
               from workflow_versions
              where tenant_id = $1 and id = $2`, [tenantId, workflowVersionId]);
                    if (v.rowCount === 0) {
                        await client.query("rollback");
                        continue;
                    }
                    const graph = v.rows[0].graph;
                    // MVP graph contract:
                    // - graph.entry_node_id: string
                    // - graph.nodes: [{ id: string, type: string, config?: any }]
                    const entryNodeId = graph?.entry_node_id;
                    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
                    const entryNode = nodes.find((n) => n?.id === entryNodeId);
                    if (!entryNodeId || !entryNode) {
                        // Mark run failed with a clear error.
                        await client.query(`update workflow_runs
                  set status = 'FAILED'::workflow_run_status,
                      finished_at = now(),
                      error = $3::jsonb,
                      updated_at = now()
                where tenant_id = $1 and id = $2`, [
                            tenantId,
                            runId,
                            JSON.stringify({
                                error: "invalid_graph",
                                entry_node_id: entryNodeId,
                            }),
                        ]);
                        await client.query("commit");
                        created.push({
                            run_id: runId,
                            created: false,
                            reason: "invalid_graph",
                        });
                        continue;
                    }
                    const nr = await client.query(`insert into node_runs (
               tenant_id, workflow_run_id, node_id, node_type,
               status, attempt, max_attempts,
               queued_at, input, updated_at
             )
             values ($1, $2, $3, $4, 'READY'::node_run_status, 0, 3, now(), '{}'::jsonb, now())
             returning id, workflow_run_id, node_id, node_type, status, queued_at, created_at`, [
                        tenantId,
                        runId,
                        String(entryNodeId),
                        String(entryNode.type ?? "unknown"),
                    ]);
                    await client.query("commit");
                    created.push({ run_id: runId, node_run: nr.rows[0] });
                }
                catch (e) {
                    await client.query("rollback");
                    throw e;
                }
                finally {
                    client.release();
                }
            }
            return reply.code(200).send({
                processed: typeof runs !== "undefined" ? runs.rowCount : 0,
                created,
                progressed,
                advanced,
                failed_runs: failedRuns,
                delay_checked: typeof readyDelay !== "undefined" ? readyDelay.rowCount : 0,
                advanced_checked: advCandidates.rowCount,
                failed_checked: failCandidates.rowCount,
            });
        }
        catch (e) {
            const { statusCode, body } = toHttpError(e);
            return reply.code(statusCode).send(body);
        }
    });
}

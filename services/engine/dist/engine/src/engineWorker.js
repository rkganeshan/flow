import { Worker } from "bullmq";
import { QUEUE_ENGINE_ADVANCE, QUEUE_RUN_REQUESTS, getQueues, } from "./queues.js";
function normalizeGraph(graph) {
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const edges = Array.isArray(graph?.edges) ? graph.edges : [];
    const entryNodeId = graph?.entry_node_id;
    return { entryNodeId, nodes, edges };
}
function pickNextNodeId(edges, fromNodeId, outcome) {
    const outgoing = edges.filter((e) => String(e?.from) === String(fromNodeId));
    if (outgoing.length === 0)
        return null;
    function boolish(v) {
        if (typeof v === "boolean")
            return v;
        const s = String(v ?? "")
            .trim()
            .toLowerCase();
        return s === "1" || s === "true" || s === "yes" || s === "y";
    }
    if (outcome != null) {
        const outcomeStr = String(outcome);
        // 1) Exact string match
        const exact = outgoing.find((e) => String(e?.when) === outcomeStr);
        if (exact?.to)
            return String(exact.to);
        // 2) Boolean-equivalent match (handles true/false, 1/0, boolean types)
        try {
            const outcomeBool = boolish(outcome);
            const boolMatch = outgoing.find((e) => {
                if (e?.when == null)
                    return false;
                return boolish(e.when) === outcomeBool;
            });
            if (boolMatch?.to)
                return String(boolMatch.to);
        }
        catch { }
        // 3) Case-insensitive match as a last exact-string attempt
        const ci = outgoing.find((e) => String(e?.when).toLowerCase() === outcomeStr.toLowerCase());
        if (ci?.to)
            return String(ci.to);
    }
    // Fallback: first edge without a when, else the first edge.
    const def = outgoing.find((e) => e?.when == null);
    return String((def ?? outgoing[0])?.to ?? "") || null;
}
function getDelayMsForNode(nodes, nodeId) {
    const node = nodes.find((n) => String(n?.id) === String(nodeId));
    if (!node)
        return 0;
    if (String(node?.type) !== "delay")
        return 0;
    const seconds = Number(node?.config?.seconds ?? 0);
    if (!Number.isFinite(seconds))
        return 0;
    return Math.max(0, seconds) * 1000;
}
export async function registerEngineWorker(deps) {
    const connection = deps.redis;
    const queues = getQueues(connection);
    const runRequestsWorker = new Worker(QUEUE_RUN_REQUESTS, async (job) => {
        const runId = String(job.data?.run_id ?? "");
        if (!runId)
            return { ok: false, error: "missing_run_id" };
        const client = await deps.db.pool.connect();
        try {
            await client.query("begin");
            // Lock run.
            const run = await client.query(`select id, tenant_id, status, workflow_version_id
             from workflow_runs
            where id = $1
            for update`, [runId]);
            if (run.rowCount === 0) {
                await client.query("rollback");
                return { ok: false, error: "run_not_found" };
            }
            const r = run.rows[0];
            const tenantId = String(r.tenant_id);
            const workflowVersionId = String(r.workflow_version_id);
            if (r.status === "FAILED" || r.status === "CANCELED") {
                await client.query("rollback");
                return { ok: false, error: "run_terminal", status: r.status };
            }
            // Ensure RUNNING.
            if (r.status !== "RUNNING") {
                await client.query(`update workflow_runs
                set status = 'RUNNING'::workflow_run_status,
                    started_at = coalesce(started_at, now()),
                    updated_at = now()
              where id = $1`, [runId]);
            }
            // If there are already node_runs, don't recreate.
            const existing = await client.query(`select id
             from node_runs
            where workflow_run_id = $1
            limit 1`, [runId]);
            let initialNodeRunId = null;
            if (existing.rowCount === 0) {
                const v = await client.query(`select graph
               from workflow_versions
              where tenant_id = $1 and id = $2`, [tenantId, workflowVersionId]);
                if (v.rowCount === 0) {
                    await client.query(`update workflow_runs
                  set status = 'FAILED'::workflow_run_status,
                      finished_at = now(),
                      error = $2::jsonb,
                      updated_at = now()
                where id = $1`, [runId, JSON.stringify({ error: "version_not_found" })]);
                    await client.query("commit");
                    return { ok: false, error: "version_not_found" };
                }
                const graph = v.rows[0].graph;
                const { entryNodeId, nodes } = normalizeGraph(graph);
                const entryNode = nodes.find((n) => n?.id === entryNodeId);
                if (!entryNodeId || !entryNode) {
                    await client.query(`update workflow_runs
                  set status = 'FAILED'::workflow_run_status,
                      finished_at = now(),
                      error = $2::jsonb,
                      updated_at = now()
                where id = $1`, [
                        runId,
                        JSON.stringify({
                            error: "invalid_graph",
                            entry_node_id: entryNodeId,
                        }),
                    ]);
                    await client.query("commit");
                    return { ok: false, error: "invalid_graph" };
                }
                const nr = await client.query(`insert into node_runs (
               tenant_id, workflow_run_id, node_id, node_type,
               status, attempt, max_attempts,
               queued_at, input, updated_at
             )
             values ($1, $2, $3, $4, 'READY'::node_run_status, 0, 3, now(), '{}'::jsonb, now())
             returning id`, [tenantId, runId, String(entryNodeId), String(entryNode.type)]);
                initialNodeRunId = String(nr.rows[0].id);
                // Enqueue initial node execution (delay nodes are scheduled with delayMs).
                const delayMs = getDelayMsForNode(nodes, String(entryNodeId));
                await client.query("commit");
                await queues.nodeExecute.add("execute", { node_run_id: initialNodeRunId }, {
                    jobId: `node_execute-${initialNodeRunId}-attempt-0`,
                    delay: delayMs,
                    removeOnComplete: 1000,
                    removeOnFail: 1000,
                });
                return {
                    ok: true,
                    run_id: runId,
                    initial_node_run_id: initialNodeRunId,
                    scheduled_delay_ms: delayMs,
                };
            }
            await client.query("commit");
            return {
                ok: true,
                run_id: runId,
                initial_node_run_id: initialNodeRunId,
            };
        }
        catch (e) {
            await client.query("rollback");
            throw e;
        }
        finally {
            client.release();
        }
    }, { connection });
    const engineAdvanceWorker = new Worker(QUEUE_ENGINE_ADVANCE, async (job) => {
        const nodeRunId = String(job.data?.node_run_id ?? "");
        if (!nodeRunId)
            return { ok: false, error: "missing_node_run_id" };
        const client = await deps.db.pool.connect();
        try {
            await client.query("begin");
            const nr = await client.query(`select id, tenant_id, workflow_run_id, node_id, status, error
             from node_runs
            where id = $1
            for update`, [nodeRunId]);
            if (nr.rowCount === 0) {
                await client.query("rollback");
                return { ok: false, error: "node_run_not_found" };
            }
            const nodeRun = nr.rows[0];
            const tenantId = String(nodeRun.tenant_id);
            const runId = String(nodeRun.workflow_run_id);
            const nodeId = String(nodeRun.node_id);
            // Lock run.
            const run = await client.query(`select id, status, workflow_version_id
             from workflow_runs
            where tenant_id = $1 and id = $2
            for update`, [tenantId, runId]);
            if (run.rowCount === 0) {
                await client.query("rollback");
                return { ok: false, error: "run_not_found" };
            }
            if (run.rows[0].status !== "RUNNING") {
                await client.query("rollback");
                return { ok: true, skipped: true, run_status: run.rows[0].status };
            }
            // Failure propagation.
            if (nodeRun.status === "FAILED_FINAL") {
                await client.query(`update workflow_runs
                set status = 'FAILED'::workflow_run_status,
                    finished_at = now(),
                    error = $3::jsonb,
                    updated_at = now()
              where tenant_id = $1 and id = $2`, [
                    tenantId,
                    runId,
                    JSON.stringify({
                        error: "node_failed",
                        node_run_id: nodeRunId,
                        node_id: nodeId,
                        node_error: nodeRun.error,
                    }),
                ]);
                await client.query("commit");
                return { ok: true, terminal: "FAILED" };
            }
            if (nodeRun.status !== "SUCCEEDED") {
                await client.query("rollback");
                return { ok: true, skipped: true, node_status: nodeRun.status };
            }
            // Load outcome for branching.
            const outcomeRes = await client.query(`select outcome
             from node_runs
            where id = $1`, [nodeRunId]);
            const outcome = outcomeRes.rowCount === 1
                ? outcomeRes.rows[0].outcome
                : null;
            const workflowVersionId = String(run.rows[0].workflow_version_id);
            const ver = await client.query(`select graph
             from workflow_versions
            where tenant_id = $1 and id = $2`, [tenantId, workflowVersionId]);
            if (ver.rowCount === 0) {
                await client.query("rollback");
                return { ok: false, error: "version_not_found" };
            }
            const graph = ver.rows[0].graph;
            const { nodes, edges } = normalizeGraph(graph);
            // Debug: capture outgoing edges and outcome to help diagnose branching issues.
            const outgoing = edges.filter((e) => String(e?.from) === String(nodeId));
            try {
                await client.query(`insert into node_run_logs (tenant_id, node_run_id, level, message, data)
               values ($1, $2, 'debug', 'engine branching - pre-pick', $3::jsonb)`, [tenantId, nodeRunId, JSON.stringify({ outcome, outgoing })]);
            }
            catch (e) {
                // best-effort logging, don't fail execution on log errors
                // eslint-disable-next-line no-console
                console.warn("failed to write engine branching pre-pick log", e);
            }
            const nextNodeId = pickNextNodeId(edges, nodeId, outcome);
            try {
                const matched = outgoing.find((o) => String(o.to) === String(nextNodeId));
                await client.query(`insert into node_run_logs (tenant_id, node_run_id, level, message, data)
               values ($1, $2, 'debug', 'engine branching - post-pick', $3::jsonb)`, [
                    tenantId,
                    nodeRunId,
                    JSON.stringify({ outcome, outgoing, matched }),
                ]);
            }
            catch (e) {
                // ignore logging failures
                // eslint-disable-next-line no-console
                console.warn("failed to write engine branching post-pick log", e);
            }
            if (!nextNodeId) {
                await client.query(`update workflow_runs
                set status = 'SUCCEEDED'::workflow_run_status,
                    finished_at = now(),
                    updated_at = now()
              where tenant_id = $1 and id = $2`, [tenantId, runId]);
                await client.query("commit");
                return { ok: true, terminal: "SUCCEEDED" };
            }
            const nextNode = nodes.find((n) => n?.id === nextNodeId);
            const nextType = String(nextNode?.type ?? "unknown");
            // Create next node_run (idempotent).
            const ins = await client.query(`insert into node_runs (
             tenant_id, workflow_run_id, node_id, node_type,
             status, attempt, max_attempts,
             queued_at, input, updated_at
           )
           values ($1, $2, $3, $4, 'READY'::node_run_status, 0, 3, now(), '{}'::jsonb, now())
           on conflict (workflow_run_id, node_id)
           do update set updated_at = now()
           returning id`, [tenantId, runId, String(nextNodeId), nextType]);
            const nextNodeRunId = String(ins.rows[0].id);
            await client.query("commit");
            const delayMs = getDelayMsForNode(nodes, String(nextNodeId));
            await queues.nodeExecute.add("execute", { node_run_id: nextNodeRunId }, {
                jobId: `node_execute-${nextNodeRunId}-attempt-0`,
                delay: delayMs,
                removeOnComplete: 1000,
                removeOnFail: 1000,
            });
            return {
                ok: true,
                advanced: true,
                next_node_run_id: nextNodeRunId,
                scheduled_delay_ms: delayMs,
            };
        }
        catch (e) {
            await client.query("rollback");
            throw e;
        }
        finally {
            client.release();
        }
    }, { connection });
    const shutdown = async () => {
        await engineAdvanceWorker.close();
        await runRequestsWorker.close();
        await queues.engineAdvance.close();
        await queues.nodeExecute.close();
        await queues.runRequests.close();
    };
    return {
        workers: {
            runRequestsWorker,
            engineAdvanceWorker,
        },
        queues,
        shutdown,
    };
}

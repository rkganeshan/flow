import { z } from "zod";
import { getTenantIdFromHeaders, toHttpError } from "../http.js";
const ClaimBody = z
    .object({
    limit: z.coerce.number().int().min(1).max(50).default(5),
    types: z.array(z.string().min(1)).optional(),
})
    .default({});
/**
 * Worker-ish endpoints (MVP) to demonstrate safe claiming and execution.
 *
 * This is NOT the final architecture; later this becomes a worker service
 * consuming from a queue. The important part is that claim/execution is
 * idempotent and protected via DB state transitions.
 */
export async function registerWorkersRoutes(app) {
    const db = app.db;
    // Claim READY node_runs (READY -> IN_PROGRESS).
    app.post("/claim", { config: { requiredRole: "editor" } }, async (req, reply) => {
        try {
            const tenantId = getTenantIdFromHeaders(req.headers);
            const parsed = ClaimBody.safeParse(req.body ?? {});
            if (!parsed.success) {
                return reply
                    .code(400)
                    .send({ error: "invalid_body", details: parsed.error.flatten() });
            }
            const { limit, types } = parsed.data;
            const typeFilterSql = types?.length
                ? `and nr.node_type = any($3::text[])`
                : ``;
            const params = [tenantId, limit];
            if (types?.length)
                params.push(types);
            const client = await db.pool.connect();
            try {
                await client.query("begin");
                // Pick candidate node_runs using SKIP LOCKED to allow concurrency.
                const pick = await client.query(`select nr.id
             from node_runs nr
             join workflow_runs wr on wr.id = nr.workflow_run_id
            where nr.tenant_id = $1
              and nr.status = 'READY'::node_run_status
              and wr.status = 'RUNNING'::workflow_run_status
              ${typeFilterSql}
            order by nr.queued_at asc nulls last, nr.created_at asc
            limit $2
            for update skip locked`, params);
                const claimed = [];
                for (const r of pick.rows) {
                    const nodeRunId = r.id;
                    const upd = await client.query(`update node_runs
                set status = 'IN_PROGRESS'::node_run_status,
                    started_at = coalesce(started_at, now()),
                    updated_at = now()
              where tenant_id = $1 and id = $2
                and status = 'READY'::node_run_status
              returning id, workflow_run_id, node_id, node_type, status, started_at, queued_at`, [tenantId, nodeRunId]);
                    if (upd.rowCount === 1)
                        claimed.push(upd.rows[0]);
                }
                await client.query("commit");
                return reply.code(200).send({ items: claimed });
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
    // Execute exactly one claimed node_run (IN_PROGRESS) and update its outcome.
    app.post("/execute/:nodeRunId", { config: { requiredRole: "editor" } }, async (req, reply) => {
        try {
            const tenantId = getTenantIdFromHeaders(req.headers);
            const nodeRunId = req.params.nodeRunId;
            const env = app.env;
            const allowedHosts = parseAllowedHosts(env?.HTTP_NODE_ALLOWED_HOSTS);
            const timeoutMs = Number(env?.HTTP_NODE_TIMEOUT_MS ?? 5000);
            const maxBytes = Number(env?.HTTP_NODE_MAX_RESPONSE_BYTES ?? 100_000);
            const client = await db.pool.connect();
            try {
                await client.query("begin");
                const nr = await client.query(`select id, workflow_run_id, node_id, node_type, status
             from node_runs
            where tenant_id = $1 and id = $2
            for update`, [tenantId, nodeRunId]);
                if (nr.rowCount === 0) {
                    await client.query("rollback");
                    return reply.code(404).send({ error: "not_found" });
                }
                const row = nr.rows[0];
                if (row.status !== "IN_PROGRESS") {
                    await client.query("rollback");
                    return reply.code(409).send({ error: "not_in_progress" });
                }
                // Load workflow graph to resolve node config.
                const run = await client.query(`select workflow_version_id
             from workflow_runs
            where tenant_id = $1 and id = $2`, [tenantId, row.workflow_run_id]);
                if (run.rowCount === 0) {
                    await client.query("rollback");
                    return reply.code(409).send({ error: "run_not_found" });
                }
                const v = await client.query(`select graph
             from workflow_versions
            where tenant_id = $1 and id = $2`, [tenantId, run.rows[0].workflow_version_id]);
                if (v.rowCount === 0) {
                    await client.query("rollback");
                    return reply.code(409).send({ error: "version_not_found" });
                }
                const graph = v.rows[0].graph;
                const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
                const node = nodes.find((n) => n?.id === row.node_id);
                if (!node) {
                    await client.query("rollback");
                    return reply.code(409).send({ error: "node_not_found_in_graph" });
                }
                if (row.node_type === "delay") {
                    const done = await client.query(`update node_runs
                set status = 'SUCCEEDED'::node_run_status,
                    finished_at = now(),
                    outcome = 'success',
                    output = $3::jsonb,
                    updated_at = now()
              where tenant_id = $1 and id = $2
              returning id, workflow_run_id, node_id, node_type, status, started_at, finished_at`, [
                        tenantId,
                        nodeRunId,
                        JSON.stringify({ worker: "inline", ok: true }),
                    ]);
                    await client.query(`insert into node_run_logs (tenant_id, node_run_id, level, message, data)
             values ($1, $2, 'info', 'node executed by inline worker', $3::jsonb)`, [
                        tenantId,
                        nodeRunId,
                        JSON.stringify({ node_type: row.node_type }),
                    ]);
                    await client.query("commit");
                    return reply.code(200).send(done.rows[0]);
                }
                if (row.node_type === "http_request") {
                    const cfg = node?.config ?? {};
                    const method = String(cfg.method ?? "GET").toUpperCase();
                    const urlStr = String(cfg.url ?? "");
                    if (!urlStr) {
                        await client.query("rollback");
                        return reply.code(409).send({ error: "missing_url" });
                    }
                    let url;
                    try {
                        url = new URL(urlStr);
                    }
                    catch {
                        await client.query("rollback");
                        return reply.code(409).send({ error: "invalid_url" });
                    }
                    if (url.protocol !== "http:" && url.protocol !== "https:") {
                        await client.query("rollback");
                        return reply.code(409).send({ error: "invalid_protocol" });
                    }
                    if (!isHostAllowed(url.hostname, allowedHosts)) {
                        await client.query("rollback");
                        return reply.code(403).send({ error: "host_not_allowed" });
                    }
                    const headers = {};
                    if (cfg.headers && typeof cfg.headers === "object") {
                        for (const [k, v] of Object.entries(cfg.headers)) {
                            if (typeof v === "string")
                                headers[String(k)] = v;
                        }
                    }
                    const ac = new AbortController();
                    const t = setTimeout(() => ac.abort(), timeoutMs);
                    const started = Date.now();
                    let res;
                    try {
                        res = await fetch(url.toString(), {
                            method,
                            headers,
                            body: method === "GET" || method === "HEAD"
                                ? undefined
                                : cfg.body
                                    ? JSON.stringify(cfg.body)
                                    : undefined,
                            signal: ac.signal,
                        });
                    }
                    catch (e) {
                        clearTimeout(t);
                        const err = {
                            error: "http_request_failed",
                            message: String(e?.message ?? e),
                        };
                        const done = await client.query(`update node_runs
                  set status = 'FAILED_FINAL'::node_run_status,
                      finished_at = now(),
                      outcome = 'error',
                      error = $3::jsonb,
                      updated_at = now()
                where tenant_id = $1 and id = $2
                returning id, workflow_run_id, node_id, node_type, status, started_at, finished_at, error`, [tenantId, nodeRunId, JSON.stringify(err)]);
                        await client.query(`insert into node_run_logs (tenant_id, node_run_id, level, message, data)
               values ($1, $2, 'error', 'http_request failed', $3::jsonb)`, [
                            tenantId,
                            nodeRunId,
                            JSON.stringify({ url: url.toString(), err }),
                        ]);
                        await client.query("commit");
                        return reply.code(200).send(done.rows[0]);
                    }
                    finally {
                        clearTimeout(t);
                    }
                    const { text, truncated } = await readLimitedText(res, maxBytes);
                    const duration_ms = Date.now() - started;
                    const output = {
                        status: res.status,
                        ok: res.ok,
                        headers: Object.fromEntries(res.headers.entries()),
                        body_text: text,
                        truncated,
                        duration_ms,
                    };
                    const done = await client.query(`update node_runs
                set status = $3::node_run_status,
                    finished_at = now(),
                    outcome = $4,
                    output = $5::jsonb,
                    updated_at = now()
              where tenant_id = $1 and id = $2
              returning id, workflow_run_id, node_id, node_type, status, started_at, finished_at`, [
                        tenantId,
                        nodeRunId,
                        res.ok ? "SUCCEEDED" : "FAILED_FINAL",
                        res.ok ? "success" : "error",
                        JSON.stringify(output),
                    ]);
                    await client.query(`insert into node_run_logs (tenant_id, node_run_id, level, message, data)
             values ($1, $2, 'info', 'http_request completed', $3::jsonb)`, [
                        tenantId,
                        nodeRunId,
                        JSON.stringify({
                            url: url.toString(),
                            status: res.status,
                            duration_ms,
                            truncated,
                        }),
                    ]);
                    await client.query("commit");
                    return reply.code(200).send(done.rows[0]);
                }
                await client.query("rollback");
                return reply.code(409).send({ error: "unsupported_node_type" });
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
}
function parseAllowedHosts(v) {
    const s = typeof v === "string" ? v.trim() : "";
    if (!s)
        return null;
    return new Set(s
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean));
}
function isHostAllowed(host, allowed) {
    if (!allowed)
        return true;
    return allowed.has(host.toLowerCase());
}
async function readLimitedText(res, maxBytes) {
    const reader = res.body?.getReader();
    if (!reader) {
        const t = await res.text();
        if (Buffer.byteLength(t, "utf8") > maxBytes) {
            return { text: t.slice(0, maxBytes), truncated: true };
        }
        return { text: t, truncated: false };
    }
    const chunks = [];
    let total = 0;
    let truncated = false;
    while (true) {
        const { value, done } = await reader.read();
        if (done)
            break;
        if (!value)
            continue;
        if (total + value.byteLength > maxBytes) {
            const take = Math.max(0, maxBytes - total);
            if (take > 0)
                chunks.push(value.slice(0, take));
            truncated = true;
            break;
        }
        chunks.push(value);
        total += value.byteLength;
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    return { text: buf.toString("utf8"), truncated };
}

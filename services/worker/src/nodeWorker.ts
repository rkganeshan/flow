import { Queue, Worker, type Job } from "bullmq";
import * as nodemailer from "nodemailer";

import type { Db } from "../../api/src/db.js";
import {
  QUEUE_DLQ,
  QUEUE_ENGINE_ADVANCE,
  QUEUE_NODE_EXECUTE,
} from "./queues.js";

export type NodeWorkerDeps = {
  db: Db;
  redis: any;
  env: {
    HTTP_NODE_ALLOWED_HOSTS?: string;
    HTTP_NODE_TIMEOUT_MS?: number;
    HTTP_NODE_MAX_RESPONSE_BYTES?: number;
    SMTP_HOST?: string;
    SMTP_PORT?: number;
  };
};

function parseAllowedHosts(raw: string | undefined) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function isHostAllowed(hostname: string, allow: string[] | null) {
  if (!allow || allow.length === 0) return true;
  return allow.includes(hostname);
}

async function readLimitedText(res: Response, maxBytes: number) {
  const reader = res.body?.getReader();
  if (!reader) {
    return { text: await res.text(), truncated: false };
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    if (received + value.byteLength > maxBytes) {
      const remaining = Math.max(0, maxBytes - received);
      if (remaining > 0) chunks.push(value.subarray(0, remaining));
      truncated = true;
      break;
    }

    chunks.push(value);
    received += value.byteLength;
  }

  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return { text: buf.toString("utf8"), truncated };
}

function computeBackoffMs(attempt: number) {
  const base = 1000; // 1s
  const max = 60_000; // 60s
  const ms = base * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(max, ms);
}

function getByPath(obj: any, path: string) {
  // Very small JSONPath-like: "a.b.c" (no arrays for MVP)
  const parts = String(path ?? "")
    .split(".")
    .map((p) => p.trim())
    .filter(Boolean);
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as any)[p];
  }
  return cur;
}

function compare(op: string, left: any, right: any): boolean {
  switch (op) {
    case "eq":
      return left === right;
    case "neq":
      return left !== right;
    case "gt":
      return Number(left) > Number(right);
    case "gte":
      return Number(left) >= Number(right);
    case "lt":
      return Number(left) < Number(right);
    case "lte":
      return Number(left) <= Number(right);
    case "contains":
      return typeof left === "string" && typeof right === "string"
        ? left.includes(right)
        : Array.isArray(left)
          ? left.includes(right)
          : false;
    default:
      return false;
  }
}

type NodeExecutionContext = {
  tenantId: string;
  runId: string;
  nodeRunId: string;
  nodeId: string;
  nodeType: string;
  node: any;
  graph: any;
  allowedHosts: string[] | null;
  timeoutMs: number;
  maxBytes: number;
  runContext: RunContext;
};

type NodeHandlerResult = {
  status: "SUCCEEDED";
  output?: any;
  outcome?: string | null;
};

type NodeHandler = (args: {
  ctx: NodeExecutionContext;
  client: any;
}) => Promise<NodeHandlerResult>;

type NotifyProviderName = "email";

type NotifyHandlerResult = {
  provider: NotifyProviderName;
  sent: boolean;
  message_id?: string;
};

type NotifyProvider = (args: {
  ctx: NodeExecutionContext;
  client: any;
}) => Promise<NotifyHandlerResult>;

function boolish(v: any) {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "")
    .trim()
    .toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y";
}

function createNotifyProviders(
  deps: NodeWorkerDeps,
): Record<string, NotifyProvider> {
  return {
    email: async ({ ctx, client }) => {
      const cfg = ctx.node?.config ?? {};

      const toRaw = cfg.to ?? "";
      const subjectRaw = cfg.subject ?? "";
      const textRaw = cfg.text ?? cfg.body ?? "";

      // Optional templating via context_path.
      // If context_path is provided, read the value from runContext and use it as text.
      const contextPath = String(cfg.context_path ?? "").trim();
      const resolvedText = contextPath
        ? resolveContextValue({ runContext: ctx.runContext, path: contextPath })
        : undefined;

      const to = String(toRaw).trim();
      const subject = String(subjectRaw).trim();
      const text =
        resolvedText !== undefined
          ? JSON.stringify(resolvedText)
          : String(textRaw);
      const from = String(cfg.from ?? "flow@local").trim();

      if (!to) {
        throw new Error("notify.email missing 'to'");
      }

      const host = String(deps.env.SMTP_HOST ?? "localhost");
      const port = Number(deps.env.SMTP_PORT ?? 1025);

      const transporter = nodemailer.createTransport({
        host,
        port,
        secure: false,
      });

      const info = await transporter.sendMail({
        from,
        to,
        subject: subject || "Flow notification",
        text,
      });

      await client.query(
        `insert into node_run_logs (tenant_id, node_run_id, level, message, data)
         values ($1, $2, 'info', 'notify.email sent', $3::jsonb)`,
        [
          ctx.tenantId,
          ctx.nodeRunId,
          JSON.stringify({
            to,
            subject,
            context_path: contextPath || null,
            message_id: info.messageId,
            response: info.response,
          }),
        ],
      );

      return {
        provider: "email",
        sent: true,
        message_id: info.messageId,
      };
    },
  };
}

function isRetryableNotifyError(e: any) {
  const msg = String(e?.message ?? e ?? "");
  // For MVP: treat SMTP/network-ish issues as retryable.
  const retryableSubstrings = [
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "EHOSTUNREACH",
    "ENOTFOUND",
    "socket",
    "timeout",
  ];
  return retryableSubstrings.some((s) => msg.includes(s));
}

type RunContext = {
  input: any;
  nodes: Record<string, any>; // node_id -> output
};

async function buildRunContext(client: any, tenantId: string, runId: string) {
  const run = await client.query(
    `select input
       from workflow_runs
      where tenant_id = $1 and id = $2`,
    [tenantId, runId],
  );
  const input = run.rowCount === 1 ? (run.rows[0].input ?? {}) : {};

  const outs = await client.query(
    `select node_id, output, outcome
       from node_runs
      where tenant_id = $1 and workflow_run_id = $2 and status = 'SUCCEEDED'::node_run_status`,
    [tenantId, runId],
  );

  const nodes: Record<string, any> = {};
  for (const r of outs.rows) {
    const nodeId = String(r.node_id);
    nodes[nodeId] = {
      output: r.output ?? {},
      outcome: r.outcome ?? null,
    };
  }

  return { input, nodes } as RunContext;
}

function resolveContextValue(args: { runContext: RunContext; path: string }) {
  return getByPath(args.runContext, args.path);
}

function createNodeHandlers(deps: NodeWorkerDeps): Record<string, NodeHandler> {
  const notifyProviders = createNotifyProviders(deps);

  return {
    // delay/http_request/condition handlers are implemented inline below where the existing logic already lives.
    // This registry is the extension point: to add a new node type, implement a handler and register it here.
    notify: async ({ ctx, client }) => {
      const cfg = ctx.node?.config ?? {};
      const provider = String(cfg.provider ?? "email");
      const p = notifyProviders[provider];
      if (!p) {
        // non-retryable: bad config
        throw new Error(`notify unsupported provider: ${provider}`);
      }

      try {
        const res = await p({ ctx, client });
        return {
          status: "SUCCEEDED",
          outcome: "sent",
          output: res,
        };
      } catch (e: any) {
        // If retryable, throw and let outer retry policy handle.
        // If not retryable, still throw; the caller's retry policy will decide.
        // We will encode hint in message.
        const retryable = isRetryableNotifyError(e);
        const err = new Error(
          `notify provider failed (${provider})${retryable ? " [retryable]" : ""}: ${String(
            e?.message ?? e,
          )}`,
        );
        throw err;
      }
    },
  };
}

export async function registerNodeWorker(deps: NodeWorkerDeps) {
  const connection = deps.redis;

  const engineAdvanceQueue = new Queue(QUEUE_ENGINE_ADVANCE, { connection });
  const nodeExecuteQueue = new Queue(QUEUE_NODE_EXECUTE, { connection });
  const dlqQueue = new Queue(QUEUE_DLQ, { connection });

  const allowedHosts = parseAllowedHosts(deps.env.HTTP_NODE_ALLOWED_HOSTS);
  const timeoutMs = Number(deps.env.HTTP_NODE_TIMEOUT_MS ?? 5000);
  const maxBytes = Number(deps.env.HTTP_NODE_MAX_RESPONSE_BYTES ?? 100_000);

  const handlers = createNodeHandlers(deps);

  async function enqueueDlq(args: {
    tenantId: string;
    nodeRunId: string;
    workflowRunId: string;
    nodeId: string;
    nodeType: string;
    reason: string;
    error: any;
  }) {
    try {
      await dlqQueue.add(
        "failed_node_run",
        {
          tenant_id: args.tenantId,
          node_run_id: args.nodeRunId,
          workflow_run_id: args.workflowRunId,
          node_id: args.nodeId,
          node_type: args.nodeType,
          reason: args.reason,
          error: args.error,
        },
        {
          jobId: `dlq-${args.nodeRunId}`,
          removeOnComplete: false,
          removeOnFail: false,
        },
      );
    } catch (e: any) {
      console.warn("failed to enqueue DLQ item:", e?.message ?? e);
    }
  }

  const nodeExecuteWorker = new Worker(
    QUEUE_NODE_EXECUTE,
    async (job: Job) => {
      const nodeRunId = String((job.data as any)?.node_run_id ?? "");
      if (!nodeRunId) return { ok: false, error: "missing_node_run_id" };

      const client = await deps.db.pool.connect();
      try {
        await client.query("begin");

        // Lock node_run.
        const nr = await client.query(
          `select id, tenant_id, workflow_run_id, node_id, node_type, status,
                  attempt, max_attempts, queued_at
             from node_runs
            where id = $1
            for update`,
          [nodeRunId],
        );
        if (nr.rowCount === 0) {
          await client.query("rollback");
          return { ok: false, error: "node_run_not_found" };
        }

        const row = nr.rows[0];
        const tenantId = String(row.tenant_id);

        // Idempotency: if already terminal, just enqueue advance and exit.
        if (row.status === "SUCCEEDED" || row.status === "FAILED_FINAL") {
          await client.query("commit");
          await engineAdvanceQueue.add(
            "advance",
            { node_run_id: nodeRunId },
            {
              jobId: `advance-${nodeRunId}`,
              removeOnComplete: 1000,
              removeOnFail: 1000,
            },
          );
          return { ok: true, already_done: true, status: row.status };
        }

        // Reject if already executing.
        if (row.status === "IN_PROGRESS") {
          await client.query("rollback");
          return { ok: true, skipped: true, reason: "already_in_progress" };
        }

        // Move READY/FAILED_RETRYABLE -> IN_PROGRESS.
        if (row.status === "READY" || row.status === "FAILED_RETRYABLE") {
          await client.query(
            `update node_runs
                set status = 'IN_PROGRESS'::node_run_status,
                    started_at = coalesce(started_at, now()),
                    updated_at = now()
              where id = $1`,
            [nodeRunId],
          );
        }

        // Load workflow graph for node config.
        const run = await client.query(
          `select workflow_version_id, status
             from workflow_runs
            where tenant_id = $1 and id = $2`,
          [tenantId, row.workflow_run_id],
        );
        if (run.rowCount === 0) {
          await client.query("rollback");
          return { ok: false, error: "run_not_found" };
        }

        if (run.rows[0].status !== "RUNNING") {
          // Release back to READY so it can be picked up when resumed.
          await client.query(
            `update node_runs
                set status = 'READY'::node_run_status,
                    updated_at = now()
              where id = $1 and status = 'IN_PROGRESS'::node_run_status`,
            [nodeRunId],
          );
          await client.query("commit");
          return { ok: true, skipped: true, run_status: run.rows[0].status };
        }

        const v = await client.query(
          `select graph
             from workflow_versions
            where tenant_id = $1 and id = $2`,
          [tenantId, run.rows[0].workflow_version_id],
        );
        if (v.rowCount === 0) {
          await client.query("rollback");
          return { ok: false, error: "version_not_found" };
        }

        const graph = v.rows[0].graph as any;
        const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
        const node = nodes.find((n: any) => n?.id === row.node_id);
        if (!node) {
          await client.query("rollback");
          return { ok: false, error: "node_not_found_in_graph" };
        }

        const runContext = await buildRunContext(
          client,
          tenantId,
          String(row.workflow_run_id),
        );

        const ctx: NodeExecutionContext = {
          tenantId,
          runId: String(row.workflow_run_id),
          nodeRunId,
          nodeId: String(row.node_id),
          nodeType: String(row.node_type),
          node,
          graph,
          allowedHosts,
          timeoutMs,
          maxBytes,
          runContext,
        };

        const failWithRetryPolicy = async (errObj: any) => {
          // attempt is 0-based in DB; nextAttempt becomes 1..max_attempts
          const nextAttempt = Number(row.attempt ?? 0) + 1;
          const maxAttempts = Number(row.max_attempts ?? 3);

          if (nextAttempt < maxAttempts) {
            const backoffMs = computeBackoffMs(nextAttempt);

            await client.query(
              `update node_runs
                  set status = 'FAILED_RETRYABLE'::node_run_status,
                      attempt = $2,
                      error = $3::jsonb,
                      updated_at = now()
                where id = $1`,
              [nodeRunId, nextAttempt, JSON.stringify(errObj)],
            );

            await client.query(
              `insert into node_run_logs (tenant_id, node_run_id, level, message, data)
               values ($1, $2, 'warn', 'node failed (retry scheduled)', $3::jsonb)`,
              [
                tenantId,
                nodeRunId,
                JSON.stringify({
                  next_attempt: nextAttempt,
                  backoff_ms: backoffMs,
                  err: errObj,
                }),
              ],
            );

            await client.query("commit");

            await nodeExecuteQueue.add(
              "execute",
              { node_run_id: nodeRunId },
              {
                jobId: `node_execute-${nodeRunId}-attempt-${nextAttempt}`,
                delay: backoffMs,
                removeOnComplete: 1000,
                removeOnFail: 1000,
              },
            );

            return {
              ok: false,
              retry_scheduled: true,
              attempt: nextAttempt,
              backoff_ms: backoffMs,
            };
          }

          // Final failure.
          await client.query(
            `update node_runs
                set status = 'FAILED_FINAL'::node_run_status,
                    attempt = $2,
                    finished_at = now(),
                    outcome = 'error',
                    error = $3::jsonb,
                    updated_at = now()
              where id = $1`,
            [nodeRunId, nextAttempt, JSON.stringify(errObj)],
          );

          await client.query(
            `insert into node_run_logs (tenant_id, node_run_id, level, message, data)
             values ($1, $2, 'error', 'node failed (final)', $3::jsonb)`,
            [
              tenantId,
              nodeRunId,
              JSON.stringify({ attempt: nextAttempt, err: errObj }),
            ],
          );

          await client.query("commit");

          await engineAdvanceQueue.add(
            "advance",
            { node_run_id: nodeRunId },
            {
              jobId: `advance-${nodeRunId}`,
              removeOnComplete: 1000,
              removeOnFail: 1000,
            },
          );

          await enqueueDlq({
            tenantId,
            nodeRunId,
            workflowRunId: String(row.workflow_run_id),
            nodeId: String(row.node_id),
            nodeType: String(row.node_type),
            reason: "retry_exhausted",
            error: errObj,
          });

          return { ok: false, failed_final: true, attempt: nextAttempt };
        };

        // Dispatch node to handler registry first; fall back to legacy inline implementation below.
        const handler = handlers[String(row.node_type)];
        if (handler) {
          try {
            const result = await handler({ ctx, client });

            await client.query(
              `update node_runs
                  set status = 'SUCCEEDED'::node_run_status,
                      finished_at = now(),
                      output = $2::jsonb,
                      outcome = $3,
                      updated_at = now()
                where id = $1`,
              [
                nodeRunId,
                JSON.stringify(result.output ?? {}),
                result.outcome ?? null,
              ],
            );

            await client.query(
              `insert into node_run_logs (tenant_id, node_run_id, level, message, data)
               values ($1, $2, 'info', 'node succeeded', $3::jsonb)`,
              [
                tenantId,
                nodeRunId,
                JSON.stringify({ outcome: result.outcome }),
              ],
            );

            await client.query("commit");

            await engineAdvanceQueue.add(
              "advance",
              { node_run_id: nodeRunId },
              {
                jobId: `advance-${nodeRunId}`,
                removeOnComplete: 1000,
                removeOnFail: 1000,
              },
            );

            return { ok: true, node_run_id: nodeRunId, handler: row.node_type };
          } catch (e: any) {
            // Classify and apply retry policy.
            const errObj = {
              error: "handler_error",
              node_type: row.node_type,
              message: String(e?.message ?? e),
            };
            await failWithRetryPolicy(errObj);
            return { ok: false, node_run_id: nodeRunId, error: errObj };
          }
        }

        if (row.node_type === "delay") {
          const seconds = Number(node?.config?.seconds ?? 0);
          const delayMs = Number.isFinite(seconds)
            ? Math.max(0, seconds) * 1000
            : 0;

          const queuedAt = (row.queued_at as Date | null) ?? null;
          const dueAt = queuedAt ? queuedAt.getTime() + delayMs : Date.now();
          const remainingMs = Math.max(0, dueAt - Date.now());

          if (remainingMs > 0) {
            await client.query(
              `update node_runs
                  set status = 'READY'::node_run_status,
                      updated_at = now()
                where id = $1`,
              [nodeRunId],
            );
            await client.query("commit");

            await nodeExecuteQueue.add(
              "execute",
              { node_run_id: nodeRunId },
              {
                jobId: `node_execute-${nodeRunId}-delay-${dueAt}`,
                delay: remainingMs,
                removeOnComplete: 1000,
                removeOnFail: 1000,
              },
            );

            return { ok: true, delayed: true, remaining_ms: remainingMs };
          }

          const output = {
            delayed_seconds: Number.isFinite(seconds) ? seconds : 0,
          };

          const done = await client.query(
            `update node_runs
                set status = 'SUCCEEDED'::node_run_status,
                    finished_at = now(),
                    outcome = 'success',
                    output = $2::jsonb,
                    updated_at = now()
              where id = $1
              returning id, status`,
            [nodeRunId, JSON.stringify(output)],
          );

          await client.query(
            `insert into node_run_logs (tenant_id, node_run_id, level, message, data)
             values ($1, $2, 'info', 'delay completed', $3::jsonb)`,
            [tenantId, nodeRunId, JSON.stringify(output)],
          );

          await client.query("commit");

          await engineAdvanceQueue.add(
            "advance",
            { node_run_id: nodeRunId },
            {
              jobId: `advance-${nodeRunId}`,
              removeOnComplete: 1000,
              removeOnFail: 1000,
            },
          );

          return { ok: true, result: done.rows[0] };
        }

        if (row.node_type === "http_request") {
          const cfg = node?.config ?? {};
          const method = String(cfg.method ?? "GET").toUpperCase();

          const urlContextPath = String(cfg.url_context_path ?? "").trim();
          const urlStr = urlContextPath
            ? String(
                resolveContextValue({
                  runContext: ctx.runContext,
                  path: urlContextPath,
                }) ?? "",
              )
            : String(cfg.url ?? "");

          if (!urlStr) {
            await client.query("rollback");
            return await failWithRetryPolicy({ error: "missing_url" });
          }

          let url: URL;
          try {
            url = new URL(urlStr);
          } catch {
            await client.query("rollback");
            return await failWithRetryPolicy({ error: "invalid_url" });
          }

          if (url.protocol !== "http:" && url.protocol !== "https:") {
            await client.query("rollback");
            return await failWithRetryPolicy({ error: "invalid_protocol" });
          }

          if (!isHostAllowed(url.hostname, allowedHosts)) {
            // non-retryable safety failure
            await client.query(
              `update node_runs
                  set status = 'FAILED_FINAL'::node_run_status,
                      finished_at = now(),
                      outcome = 'error',
                      error = $2::jsonb,
                      updated_at = now()
                where id = $1`,
              [
                nodeRunId,
                JSON.stringify({
                  error: "host_not_allowed",
                  host: url.hostname,
                }),
              ],
            );
            await client.query("commit");
            await engineAdvanceQueue.add(
              "advance",
              { node_run_id: nodeRunId },
              {
                jobId: `advance-${nodeRunId}`,
                removeOnComplete: 1000,
                removeOnFail: 1000,
              },
            );

            await enqueueDlq({
              tenantId,
              nodeRunId,
              workflowRunId: String(row.workflow_run_id),
              nodeId: String(row.node_id),
              nodeType: String(row.node_type),
              reason: "final_failure",
              error: {
                error: "host_not_allowed",
                host: url.hostname,
              },
            });
            return { ok: false, error: "host_not_allowed" };
          }

          // Static headers + optional context-derived headers.
          const headers: Record<string, string> = {};
          if (cfg.headers && typeof cfg.headers === "object") {
            for (const [k, v] of Object.entries(cfg.headers)) {
              if (typeof v === "string") headers[String(k)] = v;
            }
          }

          const headersContextPath = String(
            cfg.headers_context_path ?? "",
          ).trim();
          if (headersContextPath) {
            const h = resolveContextValue({
              runContext: ctx.runContext,
              path: headersContextPath,
            });
            if (h && typeof h === "object" && !Array.isArray(h)) {
              for (const [k, v] of Object.entries(h as any)) {
                if (typeof v === "string") headers[String(k)] = v;
                else if (v != null) headers[String(k)] = String(v);
              }
            }
          }

          // Static body + optional context-derived body.
          const bodyContextPath = String(cfg.body_context_path ?? "").trim();
          const dynamicBody = bodyContextPath
            ? resolveContextValue({
                runContext: ctx.runContext,
                path: bodyContextPath,
              })
            : undefined;

          const bodyValue =
            dynamicBody !== undefined
              ? dynamicBody
              : cfg.body
                ? cfg.body
                : undefined;

          const ac = new AbortController();
          const t = setTimeout(() => ac.abort(), timeoutMs);
          const started = Date.now();

          let res: Response;
          try {
            res = await fetch(url.toString(), {
              method,
              headers,
              body:
                method === "GET" || method === "HEAD"
                  ? undefined
                  : bodyValue !== undefined
                    ? JSON.stringify(bodyValue)
                    : undefined,
              signal: ac.signal,
            });
          } catch (e: any) {
            clearTimeout(t);
            await client.query("rollback");
            return await failWithRetryPolicy({
              error: "http_request_failed",
              message: String(e?.message ?? e),
            });
          } finally {
            clearTimeout(t);
          }

          const { text, truncated } = await readLimitedText(res, maxBytes);
          const duration_ms = Date.now() - started;

          const output = {
            requested: {
              method,
              url: url.toString(),
              url_context_path: urlContextPath || null,
              headers_context_path: headersContextPath || null,
              body_context_path: bodyContextPath || null,
            },
            status: res.status,
            ok: res.ok,
            headers: Object.fromEntries(res.headers.entries()),
            body_text: text,
            truncated,
            duration_ms,
          };

          if (!res.ok) {
            // Treat non-2xx as retryable for now.
            await client.query("rollback");
            return await failWithRetryPolicy({
              error: "http_non_2xx",
              status: res.status,
              output,
            });
          }

          await client.query(
            `update node_runs
                set status = 'SUCCEEDED'::node_run_status,
                    finished_at = now(),
                    outcome = 'success',
                    output = $2::jsonb,
                    updated_at = now()
              where id = $1`,
            [nodeRunId, JSON.stringify(output)],
          );

          await client.query(
            `insert into node_run_logs (tenant_id, node_run_id, level, message, data)
             values ($1, $2, 'info', 'http_request completed', $3::jsonb)`,
            [
              tenantId,
              nodeRunId,
              JSON.stringify({
                url: url.toString(),
                url_context_path: urlContextPath || null,
                status: res.status,
                duration_ms,
                truncated,
              }),
            ],
          );

          await client.query("commit");

          await engineAdvanceQueue.add(
            "advance",
            { node_run_id: nodeRunId },
            {
              jobId: `advance-${nodeRunId}`,
              removeOnComplete: 1000,
              removeOnFail: 1000,
            },
          );

          return { ok: true, status: res.status };
        }

        if (row.node_type === "condition") {
          // Config contract:
          // {
          //   path: "a.b",
          //   op: "eq"|"neq"|"gt"|...,
          //   value: any,
          //   base?: "input"|"context" (default: "context")
          // }
          const cfg = node?.config ?? {};
          const path = String(cfg.path ?? "");
          const op = String(cfg.op ?? "eq");
          const expected = (cfg as any).value;
          const base = String((cfg as any).base ?? "context");

          if (!path) {
            await client.query("rollback");
            return await failWithRetryPolicy({
              error: "condition_missing_path",
            });
          }

          const root = base === "input" ? ctx.runContext.input : ctx.runContext;
          const actual = getByPath(root, path);
          const ok = compare(op, actual, expected);

          const output = {
            base,
            path,
            op,
            expected,
            actual,
            result: ok,
          };

          await client.query(
            `update node_runs
                set status = 'SUCCEEDED'::node_run_status,
                    finished_at = now(),
                    outcome = $2,
                    output = $3::jsonb,
                    updated_at = now()
              where id = $1`,
            [nodeRunId, ok ? "true" : "false", JSON.stringify(output)],
          );

          await client.query(
            `insert into node_run_logs (tenant_id, node_run_id, level, message, data)
             values ($1, $2, 'info', 'condition evaluated', $3::jsonb)`,
            [tenantId, nodeRunId, JSON.stringify(output)],
          );

          await client.query("commit");

          await engineAdvanceQueue.add(
            "advance",
            { node_run_id: nodeRunId },
            {
              jobId: `advance-${nodeRunId}`,
              removeOnComplete: 1000,
              removeOnFail: 1000,
            },
          );

          return { ok: true, result: ok };
        }

        // Unknown node type => final failure.
        await client.query(
          `update node_runs
              set status = 'FAILED_FINAL'::node_run_status,
                  finished_at = now(),
                  outcome = 'error',
                  error = $2::jsonb,
                  updated_at = now()
            where id = $1`,
          [
            nodeRunId,
            JSON.stringify({
              error: "unsupported_node_type",
              node_type: row.node_type,
            }),
          ],
        );

        await client.query("commit");

        await engineAdvanceQueue.add(
          "advance",
          { node_run_id: nodeRunId },
          {
            jobId: `advance-${nodeRunId}`,
            removeOnComplete: 1000,
            removeOnFail: 1000,
          },
        );

        await enqueueDlq({
          tenantId,
          nodeRunId,
          workflowRunId: String(row.workflow_run_id),
          nodeId: String(row.node_id),
          nodeType: String(row.node_type),
          reason: "unsupported_node_type",
          error: {
            error: "unsupported_node_type",
            node_type: row.node_type,
          },
        });

        return { ok: false, error: "unsupported_node_type" };
      } catch (e) {
        await client.query("rollback");
        throw e;
      } finally {
        client.release();
      }
    },
    { connection },
  );

  nodeExecuteWorker.on("failed", (job: Job | undefined, err: Error) => {
    console.error("[worker] job failed", { jobId: job?.id, err: String(err) });
  });

  return {
    worker: nodeExecuteWorker,
    shutdown: async () => {
      await nodeExecuteWorker.close();
      await engineAdvanceQueue.close();
      await nodeExecuteQueue.close();
      await dlqQueue.close();
    },
  };
}

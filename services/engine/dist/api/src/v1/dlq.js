import { z } from "zod";
import { toHttpError } from "../http.js";
const QuerySchema = z.object({
    state: z
        .enum(["waiting", "delayed", "active", "failed", "completed"])
        .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
});
export async function registerDlqRoutes(app) {
    app.get("/", { config: { requiredRole: "owner" } }, async (req, reply) => {
        try {
            const parsed = QuerySchema.safeParse(req.query ?? {});
            if (!parsed.success) {
                return reply
                    .code(400)
                    .send({ error: "invalid_query", details: parsed.error.flatten() });
            }
            const dlqQueue = app.queues?.dlq;
            if (!dlqQueue) {
                return reply.code(503).send({ error: "dlq_unavailable" });
            }
            const states = parsed.data.state
                ? [parsed.data.state]
                : ["waiting", "delayed", "active", "failed"];
            const jobs = await dlqQueue.getJobs(states, 0, parsed.data.limit - 1, true);
            return {
                items: await Promise.all(jobs.map(async (job) => ({
                    id: job.id,
                    name: job.name,
                    state: await job.getState(),
                    data: job.data,
                    opts: job.opts,
                    attemptsMade: job.attemptsMade,
                    timestamp: job.timestamp,
                    processedOn: job.processedOn,
                    finishedOn: job.finishedOn,
                    failedReason: job.failedReason,
                }))),
            };
        }
        catch (e) {
            const { statusCode, body } = toHttpError(e);
            return reply.code(statusCode).send(body);
        }
    });
    app.post("/:jobId/resolve", { config: { requiredRole: "owner" } }, async (req, reply) => {
        try {
            const jobId = req.params.jobId;
            if (!jobId) {
                return reply.code(400).send({ error: "missing_job_id" });
            }
            const dlqQueue = app.queues?.dlq;
            if (!dlqQueue) {
                return reply.code(503).send({ error: "dlq_unavailable" });
            }
            const job = await dlqQueue.getJob(jobId);
            if (!job) {
                return reply.code(404).send({ error: "not_found" });
            }
            const state = await job.getState();
            await job.remove();
            return {
                ok: true,
                jobId,
                removedState: state,
            };
        }
        catch (e) {
            const { statusCode, body } = toHttpError(e);
            return reply.code(statusCode).send(body);
        }
    });
}

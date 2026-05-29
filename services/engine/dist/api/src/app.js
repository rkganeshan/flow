import Fastify from "fastify";
import cors from "@fastify/cors";
import { createDb } from "./db.js";
import { registerV1Routes } from "./v1/index.js";
import { authenticateRequest, enforceRateLimit, getRequiredRoleFromRoute, publicRoute, roleAtLeast, } from "./auth.js";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
const QUEUE_RUN_REQUESTS = "run_requests";
const QUEUE_DLQ = "dlq";
export async function buildApp(env) {
    const db = createDb(env.DATABASE_URL);
    const app = Fastify({
        logger: {
            level: "info",
        },
    });
    // Attach shared deps (simple DI for now)
    app.db = db;
    app.env = env;
    // BullMQ/Redis: best-effort in API process (engine service consumes).
    // If Redis isn't available, the API still runs (DB remains source of truth).
    try {
        const redis = new Redis(env.REDIS_URL);
        app.redis = redis;
        app.queues = {
            runRequests: new Queue(QUEUE_RUN_REQUESTS, { connection: redis }),
            dlq: new Queue(QUEUE_DLQ, { connection: redis }),
        };
        app.addHook("onClose", async () => {
            try {
                await app.queues?.runRequests?.close();
            }
            catch { }
            try {
                await app.queues?.dlq?.close();
            }
            catch { }
            try {
                await redis.quit();
            }
            catch { }
        });
    }
    catch {
        app.queues = {};
    }
    await app.register(cors, {
        origin: env.CORS_ORIGIN ? env.CORS_ORIGIN.split(",") : true,
    });
    app.addHook("preHandler", async (req, reply) => {
        const url = req.url;
        const redis = app.redis;
        if (url === "/v1/auth/register" || url === "/v1/auth/login") {
            try {
                await enforceRateLimit({
                    redis,
                    scope: "auth",
                    key: req.ip,
                    limit: env.AUTH_PUBLIC_RATE_LIMIT_PER_MINUTE,
                    windowSeconds: 60,
                });
            }
            catch (e) {
                if (Number(e?.statusCode) === 429) {
                    return reply.code(429).send({ error: "rate_limit_exceeded" });
                }
                throw e;
            }
            return;
        }
        if (url.startsWith("/v1/triggers/webhooks")) {
            try {
                await enforceRateLimit({
                    redis,
                    scope: "webhook",
                    key: req.ip,
                    limit: env.AUTH_PUBLIC_RATE_LIMIT_PER_MINUTE,
                    windowSeconds: 60,
                });
            }
            catch (e) {
                if (Number(e?.statusCode) === 429) {
                    return reply.code(429).send({ error: "rate_limit_exceeded" });
                }
                throw e;
            }
        }
        if (publicRoute(req))
            return;
        const auth = await authenticateRequest({ db, request: req });
        if (!auth) {
            return reply.code(401).send({ error: "unauthorized" });
        }
        req.auth = auth;
        const tenantHeader = String(req.headers["x-tenant-id"] ?? "").trim();
        if (tenantHeader && tenantHeader !== auth.tenantId) {
            return reply.code(403).send({ error: "tenant_mismatch" });
        }
        req.headers["x-tenant-id"] = auth.tenantId;
        const requiredRole = getRequiredRoleFromRoute(req);
        if (requiredRole && !roleAtLeast(auth.role, requiredRole)) {
            return reply.code(403).send({ error: "forbidden" });
        }
        try {
            await enforceRateLimit({
                redis,
                scope: "tenant",
                key: auth.tenantId,
                limit: env.AUTH_RATE_LIMIT_PER_MINUTE,
                windowSeconds: 60,
            });
        }
        catch (e) {
            if (Number(e?.statusCode) === 429) {
                return reply.code(429).send({ error: "rate_limit_exceeded" });
            }
            throw e;
        }
    });
    app.get("/healthz", async () => ({ ok: true }));
    app.get("/readyz", async () => {
        const r = await db.pool.query("select 1 as ok");
        return { ok: r.rows?.[0]?.ok === 1 };
    });
    // Versioned API surface (easy v1 -> v2 in future)
    await app.register(registerV1Routes, { prefix: "/v1" });
    return { app, db };
}

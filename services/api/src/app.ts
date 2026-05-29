import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";

import type { Env } from "./env.js";
import { createDb, type Db } from "./db.js";
import { registerV1Routes } from "./v1/index.js";
import {
  authenticateRequest,
  enforceRateLimit,
  getRequiredRoleFromRoute,
  publicRoute,
  roleAtLeast,
} from "./auth.js";

import { Queue } from "bullmq";
import { Redis } from "ioredis";

const QUEUE_RUN_REQUESTS = "run_requests";
const QUEUE_DLQ = "dlq";

export type App = {
  app: FastifyInstance;
  db: Db;
};

export async function buildApp(env: Env): Promise<App> {
  const db = createDb(env.DATABASE_URL);

  const app = Fastify({
    logger: {
      level: "info",
    },
  });

  // Attach shared deps (simple DI for now)
  (app as any).db = db;
  (app as any).env = env;

  // BullMQ/Redis: best-effort in API process (engine service consumes).
  // If Redis isn't available, the API still runs (DB remains source of truth).
  try {
    const redis = new Redis(env.REDIS_URL);
    (app as any).redis = redis;
    (app as any).queues = {
      runRequests: new Queue(QUEUE_RUN_REQUESTS, { connection: redis as any }),
      dlq: new Queue(QUEUE_DLQ, { connection: redis as any }),
    };

    app.addHook("onClose", async () => {
      try {
        await (app as any).queues?.runRequests?.close();
      } catch {}
      try {
        await (app as any).queues?.dlq?.close();
      } catch {}
      try {
        await redis.quit();
      } catch {}
    });
  } catch {
    (app as any).queues = {};
  }

  await app.register(cors, {
    origin: env.CORS_ORIGIN ? env.CORS_ORIGIN.split(",") : true,
  });

  app.addHook("preHandler", async (req, reply) => {
    const url = req.url;
    const redis = (app as any).redis;

    if (url === "/v1/auth/register" || url === "/v1/auth/login") {
      try {
        await enforceRateLimit({
          redis,
          scope: "auth",
          key: req.ip,
          limit: env.AUTH_PUBLIC_RATE_LIMIT_PER_MINUTE,
          windowSeconds: 60,
        });
      } catch (e) {
        if (Number((e as any)?.statusCode) === 429) {
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
      } catch (e) {
        if (Number((e as any)?.statusCode) === 429) {
          return reply.code(429).send({ error: "rate_limit_exceeded" });
        }
        throw e;
      }
    }

    if (publicRoute(req)) return;

    const auth = await authenticateRequest({ db, request: req });
    if (!auth) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    (req as any).auth = auth;

    const tenantHeader = String(req.headers["x-tenant-id"] ?? "").trim();
    if (tenantHeader && tenantHeader !== auth.tenantId) {
      return reply.code(403).send({ error: "tenant_mismatch" });
    }

    (req.headers as any)["x-tenant-id"] = auth.tenantId;

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
    } catch (e) {
      if (Number((e as any)?.statusCode) === 429) {
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

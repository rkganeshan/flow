import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { loadEnv } from "./env.js";
import { createDb } from "./db.js";
const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const app = Fastify({
    logger: {
        level: "info",
    },
});
await app.register(cors, {
    origin: env.CORS_ORIGIN ? env.CORS_ORIGIN.split(",") : true,
});
app.get("/healthz", async () => {
    return { ok: true };
});
app.get("/readyz", async () => {
    // Fail readiness if DB is down.
    const r = await db.pool.query("select 1 as ok");
    return { ok: r.rows?.[0]?.ok === 1 };
});
app.get("/v1/tenants", async () => {
    const r = await db.pool.query("select id, slug, name, created_at from tenants order by created_at desc limit 100");
    return { items: r.rows };
});
app.post("/v1/tenants", async (req, reply) => {
    const body = req.body;
    const slug = String(body?.slug ?? "").trim();
    const name = String(body?.name ?? "").trim();
    if (!slug || !name) {
        return reply.code(400).send({ error: "slug and name are required" });
    }
    const r = await db.pool.query("insert into tenants (slug, name) values ($1, $2) returning id, slug, name, created_at", [slug, name]);
    return reply.code(201).send(r.rows[0]);
});

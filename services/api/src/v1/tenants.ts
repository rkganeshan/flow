import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "../db.js";

const CreateTenantBody = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
});

export async function registerTenantsRoutes(app: FastifyInstance) {
  const db: Db = (app as any).db;

  app.get("/", async () => {
    const r = await db.pool.query(
      "select id, slug, name, created_at from tenants order by created_at desc limit 100",
    );
    return { items: r.rows };
  });

  app.post("/", async (req, reply) => {
    const parsed = CreateTenantBody.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_body", details: parsed.error.flatten() });
    }

    const { slug, name } = parsed.data;

    const r = await db.pool.query(
      "insert into tenants (slug, name) values ($1, $2) returning id, slug, name, created_at",
      [slug, name],
    );

    return reply.code(201).send(r.rows[0]);
  });
}
